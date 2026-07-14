const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  verificationToken: {
    type: String
  },
  resetPasswordToken: {
    type: String
  },
  resetPasswordExpires: {
    type: Date
  },
  avatar: {
    type: String,
    default: ''
  },
  bio: {
    type: String,
    default: ''
  },
  recentSearches: {
    type: [{
      osmType: String,
      osmId: String,
      name: String,
      lat: Number,
      lon: Number,
      location: String,
      viewedAt: { type: Date, default: Date.now }
    }],
    default: []
  },
  unitPreference: {
    type: String,
    enum: ['imperial', 'metric'],
    default: 'imperial'
  },
  savedTrails: {
    type: [{
      trailId: String,
      name: String,
      difficulty: String,
      distanceMiles: Number,
      parkOsmType: String,
      parkOsmId: String,
      parkLat: Number,
      parkLon: Number,
      parkName: String,
      savedAt: { type: Date, default: Date.now }
    }],
    default: []
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', userSchema);