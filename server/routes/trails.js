const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  searchTrails,
  getTrailDetail,
  getRecentSearches,
  addRecentSearch,
  reverseGeocode,
  getParkLoops,
  getParkAmenities,
  getSavedTrails,
  saveTrail,
  unsaveTrail
} = require('../controllers/trailController');

router.get('/search', searchTrails);
router.get('/detail', getTrailDetail);
router.get('/reverse-geocode', reverseGeocode);
router.get('/loops', getParkLoops);
router.get('/amenities', getParkAmenities);
router.get('/recent', protect, getRecentSearches);
router.post('/recent', protect, addRecentSearch);
router.get('/saved', protect, getSavedTrails);
router.post('/saved', protect, saveTrail);
router.delete('/saved/:trailId', protect, unsaveTrail);

module.exports = router;