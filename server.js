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
const auth = Buffer.from(
  `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`,
);

// Middlewares
app.use(express.json());
app.use(cors());

const getMpesaToken = async (req, res) => {
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${auth.toString("base64")}`,
      },
    });
    return response.data.access_token;
  } catch (error) {
    res.status(500).json({ error: `Mpesa token error: ${error.message}` });
  }
};

// PostgreSQL pool setup
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// payment token route
app.get("/api/mpesa/token", getMpesaToken);

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
