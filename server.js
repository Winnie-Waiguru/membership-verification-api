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

  // Convert number to correct format
  const formattedPhone = phoneNumber.replace(/^0/, "254");
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
      PartyA: formattedPhone,
      PartyB: process.env.MPESA_SHORT_CODE,
      PhoneNumber: formattedPhone,
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
  try {
    const { full_name, school, award_type, award_year, phone_number, amount } =
      req.body;

    let membership_type;
    if (amount === 1) membership_type = "lifetime";
    else if (amount === 2000) membership_type = "monthly";
    else return res.status(400).json({ error: "Invalid amount" });

    const payment = await pool.query(
      `INSERT INTO payment_requests 
     (full_name, school, award_type, award_year, membership_type, phone_number, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        full_name,
        school,
        award_type,
        award_year,
        membership_type,
        phone_number,
        amount,
      ],
    );

    // Intiate stk push
    const stkResponse = await initiateStkPush(phone_number, amount);

    // Save checkout request id
    await pool.query(
      "UPDATE payment_requests SET checkout_request_id=$1 WHERE id=$2",
      [stkResponse.CheckoutRequestID, payment.rows[0].id],
    );

    res.status(200).json({
      message: "STK push sent to phone",
      checkoutRequestID: stkResponse.CheckoutRequestID,
    });
  } catch (error) {
    res.status(500).json({
      error: "Payment initiation failed",
      details: error.response ? error.response.data : error.message,
    });
  }
});

// Mpesa response from Saf
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    console.log("MPESA CALLBACK:", JSON.stringify(req.body, null, 2));
    const response = req.body.Body.stkCallback;

    if (response.ResultCode === 0) {
      const checkOutId = response.CheckoutRequestID;

      const payment = await pool.query(
        "SELECT * FROM payment_requests WHERE checkout_request_id=$1",
        [checkOutId],
      );

      // Check if any row was returned
      if (payment.rows.length === 0) {
        console.error("Payment not found for CheckoutRequestID:", checkOutId);
        return res.status(404).json({ error: "Payment request not found" });
      }

      // Get users details
      const user = payment.rows[0];

      // Insert into members table
      await pool.query(
        "INSERT INTO members (full_name, school, award_type, award_year,membership_type , paid) VALUES ($1, $2, $3, $4, $5, true)",
        [
          user.full_name,
          user.school,
          user.award_type,
          user.award_year,
          user.membership_type,
        ],
      );

      // update  payment status
      await pool.query(
        "UPDATE payment_requests SET status='paid' WHERE checkout_request_id=$1",
        [checkOutId],
      );
    }

    res.status(201).json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (error) {
    res.status(500).json({ "Callback Error": error.message });
  }
});

// Routes
// Get members data from the database based on the provided name & paid status
app.post("/api/members/check", async (req, res) => {
  const { name } = req.body;
  try {
    const result = await pool.query(
      "SELECT full_name, award_type FROM members WHERE full_name = $1 AND paid = true",
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
// save members data to the database
app.post("/api/members", async (req, res) => {
  const { name, school, awardType, year, paid } = req.body;

  try {
    const result = await pool.query(
      "INSERT INTO members (full_name, school, award_type, award_year, paid) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [name, school, awardType, year, paid],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: `Database error: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
