const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { searchTrails, getTrailDetail, getRecentSearches, addRecentSearch, reverseGeocode } = require('../controllers/trailController');

router.get('/search', searchTrails);
router.get('/detail', getTrailDetail);
router.get('/reverse-geocode', reverseGeocode);
router.get('/recent', protect, getRecentSearches);
router.post('/recent', protect, addRecentSearch);

module.exports = router;