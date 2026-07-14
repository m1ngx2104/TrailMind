const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendVerificationEmail = async (email, name, token) => {
  const verificationUrl = `http://localhost:5000/api/auth/verify/${token}`;
  
  await transporter.sendMail({
    from: `"TrailMind" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify your TrailMind account',
    html: `
      <h2>Welcome to TrailMind, ${name}!</h2>
      <p>Please verify your email address by clicking the link below:</p>
      <a href="${verificationUrl}" style="background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;">
        Verify Email
      </a>
      <p>This link expires in 24 hours.</p>
      <p>If you didn't create an account, ignore this email.</p>
    `
  });
};

const sendPasswordResetEmail = async (email, name, token) => {
  const resetUrl = `http://localhost:3000/reset-password/${token}`;
  
  await transporter.sendMail({
    from: `"TrailMind" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Reset your TrailMind password',
    html: `
      <h2>Password Reset Request</h2>
      <p>Hi ${name}, we received a request to reset your password.</p>
      <a href="${resetUrl}" style="background:#16a34a;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;">
        Reset Password
      </a>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request this, ignore this email.</p>
    `
  });
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };