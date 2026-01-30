const express = require("express");
const cors = require("cors");

const app = express();
const port = 3000;

// Middlewares
app.use(express.json());
app.use(cors());

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
