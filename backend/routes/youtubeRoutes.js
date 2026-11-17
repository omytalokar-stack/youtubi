import { Router } from 'express';
import { getAuthorizationUrl, connectYouTubeAccount, listConnectedChannels, getChannelStats } from '../services/youtubeService.js';
import { verifyOAuthState } from '../services/cryptoService.js';

const router = Router();

router.get('/auth-url', (req, res) => res.json({ url: getAuthorizationUrl() }));
router.get('/oauth2callback', async (req, res, next) => {
  try {
    const encodedState = req.query.state;
    if (!encodedState) throw new Error('Missing OAuth state.');
    const state = verifyOAuthState(encodedState);
    if (state.purpose !== 'youtube-connect') throw new Error('Unexpected OAuth state purpose.');
    const channels = await connectYouTubeAccount(req.query.code);
    const target = new URL('/?connected=1', process.env.PUBLIC_APP_URL || 'http://localhost:5173');
    target.searchParams.set('channelCount', String(channels.length));
    res.redirect(target.toString());
  } catch (error) {
    const target = new URL('/?error=oauth', process.env.PUBLIC_APP_URL || 'http://localhost:5173');
    const message = error?.message || 'OAuth failed while exchanging Google code.';
    target.searchParams.set('message', message);
    if (String(error?.code || '') === '400' || String(error?.status || '') === '400' || /invalid_grant|Bad Request|expired|used/i.test(message)) {
      target.searchParams.set('reason', 'google-code-expired');
    }
    res.redirect(target.toString());
  }
});
router.get('/channels', async (req, res, next) => {
  try { res.json({ channels: await listConnectedChannels() }); } catch (error) { next(error); }
});
router.get('/channels/:channelId', async (req, res, next) => {
  try {
    const channels = await listConnectedChannels();
    const channel = channels.find((item) => item.channelId === req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Connected channel not found.' });
    res.json({ channel });
  } catch (error) { next(error); }
});
router.get('/stats/:channelId', async (req, res, next) => {
  try { res.json(await getChannelStats(req.params.channelId)); } catch (error) { next(error); }
});

export default router;
