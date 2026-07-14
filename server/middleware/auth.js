const jwt = require('jsonwebtoken');

const protect = (req, res, next) => {
  try {
    const token = req.cookies?.token;

    if (!token) {
      return res.status(401).json({ message: 'Not authorized, please log in' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();

  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, please log in' });
  }
};

module.exports = { protect };