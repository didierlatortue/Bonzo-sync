import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

app.post("/bonzo/events", (req, res) => {
  const code = req.headers["x-bonzo-code"];

  if (code !== process.env.BONZO_CODE) {
    return res.status(401).send("Unauthorized");
  }

  console.log("Bonzo Event:", req.body);

  res.status(200).json({ status: "received" });
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
