import axios from "axios";
import express from "express";
import { Pool } from "pg";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
// For Mpesa integration
const url =
  "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
// Encode the consumer key and secret for basic authentication
const auth = Buffer.from(
  `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
);

// Middlewares
app.use(express.json());
app.use(cors());

// PostgreSQL pool setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const getMpesaToken = async () => {
  const response = await axios.get(url, {
    headers: {
      Authorization: `Basic ${auth.toString("base64")}`,
    },
  });
  return response.data.access_token;
};

const initiateStkPush = async (phoneNumber, amount) => {
  const token = await getMpesaToken();

  // Generate timestamp in the format YYYYMMDDHHMMSS
  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  // Get the password by base64 encoding the short code, passkey and timestamp
  const password = Buffer.from(
    `${process.env.MPESA_SHORT_CODE}${process.env.MPESA_PASSKEY}${timestamp}`,
  ).toString("base64");

  // STK URL
  const stkUrl =
    "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

  const stkRequestBody = await axios.post(
    stkUrl,
    {
      BusinessShortCode: process.env.MPESA_SHORT_CODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: process.env.MPESA_SHORT_CODE,
      PhoneNumber: phoneNumber,
      CallBackURL:
        "https://nontesting-uncapering-kasie.ngrok-free.dev/api/mpesa/callback",
      AccountReference: "Membership Payment",
      TransactionDesc: "Payment for membership",
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );

  return stkRequestBody.data;
};

// payment token route
app.post("/api/register", async (req, res) => {
  // get client from the pool
  const client = await pool.connect();

  try {
    const { full_name, school, award_type, award_year, phone_number, amount } =
      req.body;

    let membership_type;
    if (amount === 1)
      membership_type = "lifetime"; //testing amount
    else if (amount === 2)
      membership_type = "monthly"; //testing amount
    else return res.status(400).json({ error: "Invalid amount" });

    // Format phone number
    let formattedPhone = phone_number;
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.slice(1);
    }

    await client.query("BEGIN"); //start transaction

    // check if the record of previous user exists with status pending
    const existing = await client.query(
      `SELECT * FROM payment_requests 
   WHERE full_name=$1 AND award_type=$2 AND award_year=$3 AND status='pending'`,
      [full_name, award_type, award_year],
    );

    let payment;

    // if exists phone_number, amount, membership_type can be changed
    if (existing.rows.length > 0) {
      payment = await client.query(
        `UPDATE payment_requests
     SET phone_number=$1, amount=$2, membership_type=$3, created_at=NOW()
     WHERE id=$4
     RETURNING *`,
        [formattedPhone, amount, membership_type, existing.rows[0].id],
      );
    } else {
      // Insert new request
      payment = await client.query(
        `INSERT INTO payment_requests
     (full_name, school, award_type, award_year, membership_type, phone_number, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
        [
          full_name,
          school,
          award_type,
          award_year,
          membership_type,
          formattedPhone,
          amount,
        ],
      );
    }

    await client.query("COMMIT"); //Commit transaction if all goes well

    // Intiate stk push
    const stkResponse = await initiateStkPush(formattedPhone, amount);

    // check if the stk push returned
    if (!stkResponse?.CheckoutRequestID) {
      return res.status(500).json({ error: "STK push failed" });
    }

    // Save checkout request id
    await pool.query(
      "UPDATE payment_requests SET checkout_request_id=$1 WHERE id=$2",
      [stkResponse.CheckoutRequestID, payment.rows[0].id],
    );

    res.status(200).json({
      message: "STK push sent to phone",
      checkoutRequestID: stkResponse.CheckoutRequestID,
      paymentId: payment.rows[0].id,
    });
  } catch (error) {
    await client.query("ROLLBACK"); //Undo all if something fails
    res.status(500).json({
      error: "Payment initiation failed",
      details: error.response?.data || error.message,
    });
  } finally {
    client.release(); //release client back to the pool
  }
});

// Mpesa response from Saf
app.post("/api/mpesa/callback", async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("MPESA CALLBACK:", JSON.stringify(req.body, null, 2));

    const response = req.body.Body.stkCallback;

    if (response.ResultCode !== 0) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Rejected" });
    }

    const checkoutId = response.CheckoutRequestID;

    await client.query("BEGIN");

    // 1. Get payment request
    const paymentResult = await client.query(
      "SELECT * FROM payment_requests WHERE checkout_request_id=$1 FOR UPDATE",
      [checkoutId],
    );

    if (paymentResult.rows.length === 0) {
      throw new Error("Payment request not found");
    }

    const user = paymentResult.rows[0];

    // 2. Check existing member
    const memberResult = await client.query(
      "SELECT * FROM members WHERE full_name=$1 AND award_type=$2 AND award_year=$3",
      [user.full_name, user.award_type, user.award_year],
    );

    let expiryDate = null;

    if (user.membership_type === "monthly") {
      let baseDate = new Date();

      if (
        memberResult.rows.length > 0 &&
        memberResult.rows[0].expires_at &&
        new Date(memberResult.rows[0].expires_at) > new Date()
      ) {
        // carry forward
        baseDate = new Date(memberResult.rows[0].expires_at);
      }

      baseDate.setMonth(baseDate.getMonth() + 1);
      expiryDate = baseDate.toISOString().split("T")[0];
    }

    // 3. Insert or update member
    if (memberResult.rows.length === 0) {
      // New member
      await client.query(
        `INSERT INTO members 
         (full_name, school, award_type, award_year, membership_type, paid, expires_at)
         VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [
          user.full_name,
          user.school,
          user.award_type,
          user.award_year,
          user.membership_type,
          expiryDate,
        ],
      );
    } else {
      // Existing member
      let newMembershipType = memberResult.rows[0].membership_type;

      if (user.membership_type === "lifetime") {
        newMembershipType = "lifetime";
        expiryDate = null;
      }

      await client.query(
        `UPDATE members
         SET membership_type=$1,
             paid=true,
             expires_at=$2
         WHERE full_name=$3 AND award_type=$4 AND award_year=$5`,
        [
          newMembershipType,
          expiryDate,
          user.full_name,
          user.award_type,
          user.award_year,
        ],
      );
    }

    // 4. Update payment request status
    await client.query(
      "UPDATE payment_requests SET status='paid' WHERE checkout_request_id=$1",
      [checkoutId],
    );

    await client.query("COMMIT");

    res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Callback Error:", error.message);

    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Routes
// Get members data from the database based on the provided name & paid status
app.post("/api/members/check", async (req, res) => {
  const { name } = req.body;
  try {
    const result = await pool.query(
      "SELECT full_name, award_type FROM members WHERE full_name = $1 AND paid = true AND ( membership_type = 'lifetime' OR expires_at >= CURRENT_DATE",
      [name],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.status(200).json(result.rows);
  } catch (error) {
    res.status(500).json({ error: `Database error: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
