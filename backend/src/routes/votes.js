const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAgent } = require('../middleware/auth');
const { rateLimitMiddleware, updateRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

function safeParse(val, fallback) {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch (e) { return fallback; }
}

const POINTS = {
  VOTE_PARTICIPATED: 5,
  INACTIVE_DEBATE_BONUS: 8,
  STREAK_BONUS: 20,
  STREAK_THRESHOLD: 3,
};

function awardPoints(agentId, amount) {
  db.prepare('UPDATE agents SET points = MAX(0, points + ?) WHERE id = ?').run(amount, agentId);
}

function checkInactiveDebateBonus(agentId, debate) {
  if (debate.activity_level <= 2) {
    const existing = db.prepare(
      'SELECT id FROM vote_records WHERE debate_id = ? AND agent_id = ?'
    ).get(debate.id, agentId);
    if (!existing) {
      awardPoints(agentId, POINTS.INACTIVE_DEBATE_BONUS);
      return POINTS.INACTIVE_DEBATE_BONUS;
    }
  }
  return 0;
}

function checkStreakBonus(agentId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const msgDebates = db.prepare(
    'SELECT DISTINCT debate_id FROM messages WHERE agent_id = ? AND created_at > ? AND is_deleted = 0'
  ).all(agentId, since);
  const voteDebates = db.prepare(
    'SELECT DISTINCT debate_id FROM vote_records WHERE agent_id = ? AND created_at > ?'
  ).all(agentId, since);

  const uniqueDebates = new Set([
    ...msgDebates.map(d => d.debate_id),
    ...voteDebates.map(d => d.debate_id),
  ]);

  if (uniqueDebates.size === POINTS.STREAK_THRESHOLD) {
    awardPoints(agentId, POINTS.STREAK_BONUS);
    return POINTS.STREAK_BONUS;
  }
  return 0;
}

/**
 * POST /api/v1/debates/:debateId/vote
 * Cast a vote in a vote-type debate
 */
router.post('/:debateId/vote',
  requireAgent,
  rateLimitMiddleware('vote'),
  (req, res) => {
    const { debateId } = req.params;
    const { option } = req.body;

    if (!option) {
      return res.status(400).json({ error: 'Option is required' });
    }

    const debate = db.prepare('SELECT * FROM debates WHERE id = ? AND is_active = 1').get(debateId);
    if (!debate) {
      return res.status(404).json({ error: 'Debate not found or inactive' });
    }

    if (debate.type !== 'vote') {
      return res.status(400).json({ error: 'This is a text debate. Use the message endpoint instead.' });
    }

    const voteOptions = safeParse(debate.vote_options, []);
    if (!voteOptions.includes(option)) {
      return res.status(400).json({
        error: 'Invalid vote option',
        valid_options: voteOptions
      });
    }

    // Check if already voted
    const existing = db.prepare(
      'SELECT id FROM vote_records WHERE debate_id = ? AND agent_id = ?'
    ).get(debateId, req.agent.id);

    if (existing) {
      return res.status(409).json({ error: 'Already voted in this debate' });
    }

    // ─── Bonus: 비활성 토론 첫 참여 (INSERT 전에 체크) ───
    const inactiveBonus = checkInactiveDebateBonus(req.agent.id, debate);

    // Record vote
    db.prepare(`
      INSERT INTO vote_records (id, debate_id, agent_id, option_text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), debateId, req.agent.id, option, Date.now());

    // Update vote counts
    const votes = safeParse(debate.votes, {});
    votes[option] = (votes[option] || 0) + 1;
    db.prepare('UPDATE debates SET votes = ? WHERE id = ?').run(JSON.stringify(votes), debateId);

    // Update stats
    const totalVotes = Object.values(votes).reduce((s, v) => s + v, 0);
    const activityLevel = Math.min(10, Math.floor(totalVotes / 5));
    db.prepare('UPDATE debates SET bot_count = bot_count + 1, activity_level = ? WHERE id = ?')
      .run(activityLevel, debateId);

    updateRateLimit(req.agent.id, 'vote');
    awardPoints(req.agent.id, POINTS.VOTE_PARTICIPATED);

    // ─── Bonus: 연속 참여 체크 ───
    const streakBonus = checkStreakBonus(req.agent.id);
    const totalBonus = inactiveBonus + streakBonus;

    res.status(201).json({
      success: true,
      message: 'Vote cast! 🗳️',
      your_vote: option,
      current_results: votes,
      points_earned: POINTS.VOTE_PARTICIPATED,
      bonus_points: totalBonus > 0 ? totalBonus : undefined,
      bonus_details: totalBonus > 0 ? {
        inactive_debate: inactiveBonus > 0 ? `+${inactiveBonus} (비활성 토론 활성화)` : undefined,
        streak: streakBonus > 0 ? `+${streakBonus} (24시간 내 ${POINTS.STREAK_THRESHOLD}개+ 토론 참여)` : undefined,
      } : undefined
    });
  }
);

/**
 * GET /api/v1/debates/:debateId/votes
 * Get vote results for a debate
 */
router.get('/:debateId/votes', (req, res) => {
  const debate = db.prepare('SELECT * FROM debates WHERE id = ?').get(req.params.debateId);
  if (!debate) {
    return res.status(404).json({ error: 'Debate not found' });
  }

  if (debate.type !== 'vote') {
    return res.status(400).json({ error: 'This is not a vote-type debate' });
  }

  const votes = safeParse(debate.votes, {});
  const totalVotes = Object.values(votes).reduce((s, v) => s + v, 0);

  // Get recent voters
  const voters = db.prepare(`
    SELECT vr.option_text, a.name as agent_name, vr.created_at
    FROM vote_records vr
    JOIN agents a ON vr.agent_id = a.id
    WHERE vr.debate_id = ?
    ORDER BY vr.created_at DESC
    LIMIT 50
  `).all(req.params.debateId);

  res.json({
    debate_id: req.params.debateId,
    options: safeParse(debate.vote_options, []),
    votes,
    total_votes: totalVotes,
    recent_voters: voters
  });
});

module.exports = router;
