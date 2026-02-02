const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

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

// Routes
app.post("/api/members", async (req, res) => {
  const { name, school, awardType, year, paid } = req.body;
  // save members data to the database
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
