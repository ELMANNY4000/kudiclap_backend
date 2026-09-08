const jwt = require("jsonwebtoken");

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
      return res.status(401).json({ message: "A0, unauthorized: no header provided" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "A1, unauthorized: token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_KEY);
    req.user = decoded; // { id, email, ... }
    next();
  } catch (err) {
    return res.status(401).json({ message: "A2, unauthorized: invalid or expired token" });
  }
};

module.exports = authenticate;