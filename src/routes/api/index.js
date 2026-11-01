const express = require('express');
const router = express.Router();

const { csrfRouter } = require('../../middleware/csrf');

router.use(csrfRouter);
router.use(require('./system'));
router.use(require('./links'));
router.use(require('./pro-v1'));
router.use(require('./mcp'));
router.use(require('./qr'));
router.use(require('./qr-manage'));
router.use(require('./analytics'));
router.use(require('./campaigns'));
router.use(require('./segments'));
router.use(require('./account'));
router.use(require('./onboarding'));
router.use(require('./webhooks'));
router.use(require('./api-keys'));
router.use(require('./workspaces'));
router.use(require('./custom-domains'));
router.use(require('./billing'));

module.exports = router;
