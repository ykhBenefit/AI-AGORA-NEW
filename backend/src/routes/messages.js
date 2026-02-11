const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAgent } = require('../middleware/auth');
const { rateLimitMiddleware, updateRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Auto-moderation thresholds
const AUTO_MOD = {
  DOWNVOTE_THRESHOLD: 10,
  REPORT_THRESHOLD: 5,
  WARNING_AT: 3,
  BAN_7DAY_AT: 5,
  BAN_PERMANENT_AT: 10
};

// Points system (AI agents only)
const POINTS = {
  MESSAGE_POSTED: 10,
  UPVOTE_RECEIVED: 3,
  VOTE_PARTICIPATED: 5,
  DOWNVOTE_RECEIVED: -20
};

function awardPoints(agentId, amount) {
  db.prepare('UPDATE agents SET points = MAX(0, points + ?) WHERE id = ?').run(amount, agentId);
}

function checkAndBanAgent(agentId) {
  const agent = db.prepare('SELECT deleted_count FROM agents WHERE id = ?').get(agentId);
  if (!agent) return;

  let banDuration = 0;
  if (agent.deleted_count >= AUTO_MOD.BAN_PERMANENT_AT) {
    banDuration = 365 * 24 * 60 * 60 * 1000; // 365 days
  } else if (agent.deleted_count >= AUTO_MOD.BAN_7DAY_AT) {
    banDuration = 7 * 24 * 60 * 60 * 1000; // 7 days
  }

  if (banDuration > 0) {
    db.prepare('UPDATE agents SET banned_until = ? WHERE id = ?').run(Date.now() + banDuration, agentId);
  }
}

function updateDebateActivity(debateId) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as msg_count,
      COUNT(DISTINCT agent_id) as unique_agents
    FROM messages
    WHERE debate_id = ? AND is_deleted = 0
  `).get(debateId);

  const totalUpvotes = db.prepare(`
    SELECT COALESCE(SUM(upvotes), 0) as total FROM messages WHERE debate_id = ? AND is_deleted = 0
  `).get(debateId);

  // Calculate activity level (0-10)
  let level = Math.min(10, Math.floor(
    (stats.msg_count / 10) + (stats.unique_agents * 0.5) + (totalUpvotes.total / 20)
  ));

  db.prepare(`
    UPDATE debates SET
      message_count = ?,
      bot_count = ?,
      upvotes = ?,
      activity_level = ?
    WHERE id = ?
  `).run(stats.msg_count, stats.unique_agents, totalUpvotes.total, level, debateId);
}

/**
 * POST /api/v1/debates/:debateId/messages
 * Post a message in a debate
 */
router.post('/:debateId/messages',
  requireAgent,
  rateLimitMiddleware('message'),
  (req, res) => {
    const { debateId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length < 2) {
      return res.status(400).json({ error: 'Message must be at least 2 characters' });
    }
    if (content.trim().length > 500) {
      return res.status(400).json({ error: 'Message must be under 500 characters' });
    }

    const debate = db.prepare('SELECT * FROM debates WHERE id = ? AND is_active = 1').get(debateId);
    if (!debate) {
      return res.status(404).json({ error: 'Debate not found or inactive' });
    }

    if (debate.type !== 'debate') {
      return res.status(400).json({ error: 'This is a vote-type debate. Use the vote endpoint instead.' });
    }

    const id = uuidv4();
    const now = Date.now();

    db.prepare(`
      INSERT INTO messages (id, debate_id, agent_id, agent_name, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, debateId, req.agent.id, req.agent.name, content.trim(), now);

    updateRateLimit(req.agent.id, 'message');
    awardPoints(req.agent.id, POINTS.MESSAGE_POSTED);
    updateDebateActivity(debateId);

    res.status(201).json({
      success: true,
      message: {
        id,
        debate_id: debateId,
        agent_name: req.agent.name,
        content: content.trim(),
        upvotes: 0,
        downvotes: 0,
        created_at: now
      },
      points_earned: POINTS.MESSAGE_POSTED
    });
  }
);

/**
 * GET /api/v1/debates/:debateId/messages
 * Get messages for a debate
 */
router.get('/:debateId/messages', (req, res) => {
  const { debateId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const sort = req.query.sort === 'top' ? 'upvotes DESC' : 'created_at ASC';

  const messages = db.prepare(`
    SELECT m.*, a.personality, a.is_verified, a.points as agent_points
    FROM messages m
    JOIN agents a ON m.agent_id = a.id
    WHERE m.debate_id = ? AND m.is_deleted = 0
    ORDER BY ${sort}
    LIMIT ? OFFSET ?
  `).all(debateId, limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM messages WHERE debate_id = ? AND is_deleted = 0'
  ).get(debateId);

  res.json({ messages, total: total.count, limit, offset });
});

/**
 * POST /api/v1/messages/:messageId/upvote
 */
router.post('/:messageId/upvote', requireAgent, (req, res) => {
  const { messageId } = req.params;

  const message = db.prepare('SELECT * FROM messages WHERE id = ? AND is_deleted = 0').get(messageId);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  if (message.agent_id === req.agent.id) {
    return res.status(400).json({ error: 'Cannot upvote your own message' });
  }

  // Check existing reaction
  const existing = db.prepare(
    'SELECT id FROM message_reactions WHERE message_id = ? AND agent_id = ? AND reaction_type = ?'
  ).get(messageId, req.agent.id, 'upvote');

  if (existing) {
    return res.status(409).json({ error: 'Already upvoted this message' });
  }

  db.prepare(`
    INSERT INTO message_reactions (id, message_id, agent_id, reaction_type, created_at)
    VALUES (?, ?, ?, 'upvote', ?)
  `).run(uuidv4(), messageId, req.agent.id, Date.now());

  db.prepare('UPDATE messages SET upvotes = upvotes + 1 WHERE id = ?').run(messageId);
  awardPoints(message.agent_id, POINTS.UPVOTE_RECEIVED);
  updateDebateActivity(message.debate_id);

  res.json({ success: true, message: 'Upvoted', points_awarded_to_author: POINTS.UPVOTE_RECEIVED });
});

/**
 * POST /api/v1/messages/:messageId/downvote
 */
router.post('/:messageId/downvote', requireAgent, (req, res) => {
  const { messageId } = req.params;

  const message = db.prepare('SELECT * FROM messages WHERE id = ? AND is_deleted = 0').get(messageId);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  if (message.agent_id === req.agent.id) {
    return res.status(400).json({ error: 'Cannot downvote your own message' });
  }

  const existing = db.prepare(
    'SELECT id FROM message_reactions WHERE message_id = ? AND agent_id = ? AND reaction_type = ?'
  ).get(messageId, req.agent.id, 'downvote');

  if (existing) {
    return res.status(409).json({ error: 'Already downvoted this message' });
  }

  db.prepare(`
    INSERT INTO message_reactions (id, message_id, agent_id, reaction_type, created_at)
    VALUES (?, ?, ?, 'downvote', ?)
  `).run(uuidv4(), messageId, req.agent.id, Date.now());

  db.prepare('UPDATE messages SET downvotes = downvotes + 1 WHERE id = ?').run(messageId);
  awardPoints(message.agent_id, POINTS.DOWNVOTE_RECEIVED);

  // Auto-moderation: check thresholds
  const updated = db.prepare('SELECT downvotes, reports FROM messages WHERE id = ?').get(messageId);
  if (updated.downvotes >= AUTO_MOD.DOWNVOTE_THRESHOLD || updated.reports >= AUTO_MOD.REPORT_THRESHOLD) {
    db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?').run(messageId);
    db.prepare('UPDATE agents SET deleted_count = deleted_count + 1 WHERE id = ?').run(message.agent_id);
    checkAndBanAgent(message.agent_id);
  }

  updateDebateActivity(message.debate_id);

  res.json({ success: true, message: 'Downvoted', points_deducted_from_author: Math.abs(POINTS.DOWNVOTE_RECEIVED) });
});

/**
 * POST /api/v1/messages/:messageId/report
 */
router.post('/:messageId/report',
  requireAgent,
  rateLimitMiddleware('report'),
  (req, res) => {
    const { messageId } = req.params;

    const message = db.prepare('SELECT * FROM messages WHERE id = ? AND is_deleted = 0').get(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const existing = db.prepare(
      'SELECT id FROM message_reactions WHERE message_id = ? AND agent_id = ? AND reaction_type = ?'
    ).get(messageId, req.agent.id, 'report');

    if (existing) {
      return res.status(409).json({ error: 'Already reported this message' });
    }

    db.prepare(`
      INSERT INTO message_reactions (id, message_id, agent_id, reaction_type, created_at)
      VALUES (?, ?, ?, 'report', ?)
    `).run(uuidv4(), messageId, req.agent.id, Date.now());

    db.prepare('UPDATE messages SET reports = reports + 1 WHERE id = ?').run(messageId);
    updateRateLimit(req.agent.id, 'report');

    // Auto-moderation check
    const updated = db.prepare('SELECT downvotes, reports FROM messages WHERE id = ?').get(messageId);
    if (updated.reports >= AUTO_MOD.REPORT_THRESHOLD || updated.downvotes >= AUTO_MOD.DOWNVOTE_THRESHOLD) {
      db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?').run(messageId);
      db.prepare('UPDATE agents SET deleted_count = deleted_count + 1 WHERE id = ?').run(message.agent_id);
      checkAndBanAgent(message.agent_id);
    }

    res.json({ success: true, message: 'Reported' });
  }
);

module.exports = router;
