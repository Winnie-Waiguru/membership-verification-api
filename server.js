import axios from "axios";
import express from "express";
import { Pool } from "pg";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import cron from "node-cron";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// MPesa token
const getMpesaToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
  );

  const response = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: { Authorization: `Basic ${auth.toString("base64")}` },
    },
  );

  return response.data.access_token;
};

// STK Push
const initiateStkPush = async (phoneNumber, amount) => {
  const token = await getMpesaToken();

  const timestamp = new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);

  const password = Buffer.from(
    `${process.env.MPESA_SHORT_CODE}${process.env.MPESA_PASSKEY}${timestamp}`,
  ).toString("base64");

  const stkUrl =
    "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

  const response = await axios.post(
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
      TransactionDesc: "Membership Payment",
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );

  return response.data;
};

// EMAIL
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// EXPIRY EMAIL JOB
const sendExpiryEmails = async () => {
  const result = await pool.query(
    `SELECT id, full_name, email FROM members
     WHERE expires_at = CURRENT_DATE
     AND membership_type='monthly'
     AND expiry_notified=false`,
  );

  for (let member of result.rows) {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: member.email,
      subject: "Membership Expiry Notice",
      text: `Hi ${member.full_name}, your membership expires today.`,
    });

    await pool.query("UPDATE members SET expiry_notified=true WHERE id=$1", [
      member.id,
    ]);
  }
};

cron.schedule("0 8 * * *", sendExpiryEmails);

// REGISTER (before payment)
app.post("/api/register", async (req, res) => {
  const client = await pool.connect();

  try {
    const data = req.body;

    // Determine membership type based on amount
    let membership_type;
    if (data.amount === 1) membership_type = "lifetime";
    else if (data.amount === 2) membership_type = "monthly";
    else return res.status(400).json({ error: "Invalid amount" });

    // Normalize phone
    let phone = data.phone_number;
    if (phone.startsWith("0")) phone = "254" + phone.slice(1);

    await client.query("BEGIN");

    // Insert payment request
    const insert = await client.query(
      `INSERT INTO payment_requests (
        full_name, date_of_birth, gender, nationality, id_passport_number,
        email, phone_number, award_center_name, award_center_county,
        highest_award_level_achieved, award_year, occupation, experience_level,
        current_employer, linkedin_profile_link, areas_of_interest,
        skills_expertise, aspirations, membership_type,
        national_id_document, award_certificate_document, passport_photo,
        amount
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
      ) RETURNING *`,
      [
        data.full_name,
        data.date_of_birth,
        data.gender,
        data.nationality,
        data.id_passport_number,
        data.email,
        phone,
        data.award_center_name,
        data.award_center_county,
        data.highest_award_level_achieved,
        data.award_year,
        data.occupation,
        data.experience_level,
        data.current_employer,
        data.linkedin_profile_link,
        data.areas_of_interest,
        data.skills_expertise,
        data.aspirations,
        membership_type,
        data.national_id_document,
        data.award_certificate_document,
        data.passport_photo,
        data.amount,
      ],
    );

    let stkCheckoutId = null;

    // Attempt STK Push, but don’t fail registration if it fails
    try {
      const stk = await initiateStkPush(phone, data.amount);
      stkCheckoutId = stk.CheckoutRequestID;

      await client.query(
        "UPDATE payment_requests SET checkout_request_id=$1 WHERE id=$2",
        [stkCheckoutId, insert.rows[0].id],
      );
    } catch (err) {
      console.error(
        "STK Push failed, payment request created anyway:",
        err.response?.data || err.message,
      );
    }

    await client.query("COMMIT");

    res.json({
      message: "Registration successful",
      checkoutRequestID: stkCheckoutId,
      note: stkCheckoutId
        ? "STK Push initiated"
        : "STK Push failed, try again later",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// MPESA CALLBACK
app.post("/api/mpesa/callback", async (req, res) => {
  console.log("MPESA CALLBACK RECEIVED:", JSON.stringify(req.body, null, 2));
  const client = await pool.connect();

  try {
    const response = req.body?.Body?.stkCallback;

    if (!response) {
      console.error("Invalid callback structure", req.body);
      return res.json({ ResultCode: 0 });
    }

    if (response.ResultCode !== 0) {
      console.log("Payment failed:", response.ResultDesc);
      return res.json({ ResultCode: 0 });
    }

    const checkoutId = response.CheckoutRequestID;

    await client.query("BEGIN");

    // Find payment request
    const payment = await client.query(
      "SELECT * FROM payment_requests WHERE checkout_request_id=$1",
      [checkoutId],
    );

    if (!payment.rows.length) {
      console.error("Payment request not found for:", checkoutId);
      await client.query("ROLLBACK");
      return res.json({ ResultCode: 0 });
    }

    const user = payment.rows[0];

    // Check if member already exists
    const existing = await client.query(
      "SELECT * FROM members WHERE id_passport_number=$1",
      [user.id_passport_number],
    );

    let expiryDate = null;
    if (user.membership_type === "monthly") {
      const currentExpiry = existing.rows[0]?.expires_at
        ? new Date(existing.rows[0].expires_at)
        : new Date();
      const newExpiry = new Date(currentExpiry);
      newExpiry.setMonth(newExpiry.getMonth() + 1);
      expiryDate = newExpiry.toISOString().split("T")[0];
    }

    if (!existing.rows.length) {
      // Insert new member
      await client.query(
        `INSERT INTO members (
          full_name, date_of_birth, gender, nationality, id_passport_number,
          email, phone_number, award_center_name, award_center_county,
          highest_award_level_achieved, award_year, occupation, experience_level,
          current_employer, linkedin_profile_link, areas_of_interest,
          skills_expertise, aspirations, membership_type, expires_at,
          national_id_document, award_certificate_document, passport_photo
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )`,
        [
          user.full_name,
          user.date_of_birth,
          user.gender,
          user.nationality,
          user.id_passport_number,
          user.email,
          user.phone_number,
          user.award_center_name,
          user.award_center_county,
          user.highest_award_level_achieved,
          user.award_year,
          user.occupation,
          user.experience_level,
          user.current_employer,
          user.linkedin_profile_link,
          user.areas_of_interest,
          user.skills_expertise,
          user.aspirations,
          user.membership_type,
          expiryDate, // null for lifetime, date for monthly
          user.national_id_document,
          user.award_certificate_document,
          user.passport_photo,
        ],
      );
      console.log("New member added:", user.id_passport_number);
    } else {
      // Member exists
      if (user.membership_type === "monthly") {
        // Extend expiry for monthly members
        await client.query(
          `UPDATE members SET expires_at=$1 WHERE id_passport_number=$2`,
          [expiryDate, user.id_passport_number],
        );
        console.log(
          "Monthly membership extended for:",
          user.id_passport_number,
        );
      } else {
        // Lifetime member: skip insert/update
        console.log("Lifetime member already exists:", user.id_passport_number);
      }
    }

    // Mark payment request as paid
    await client.query(
      "UPDATE payment_requests SET status='paid' WHERE checkout_request_id=$1",
      [checkoutId],
    );

    await client.query("COMMIT");
    console.log("Payment marked as PAID:", checkoutId);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error processing MPESA callback:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// MEMBER CHECK
app.post("/api/members/check", async (req, res) => {
  const { name } = req.body;

  const result = await pool.query(
    `SELECT full_name, highest_award_level_achieved
     FROM members
     WHERE full_name=$1
     AND (membership_type='lifetime' OR expires_at >= CURRENT_DATE)`,
    [name],
  );

  if (!result.rows.length)
    return res.status(404).json({ message: "Not found" });

  res.json(result.rows);
});

app.listen(port, () => console.log(`Server running on ${port}`));
