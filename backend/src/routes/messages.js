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
  DOWNVOTE_RECEIVED: -20,
  // ─── Bonus points ───
  QUALITY_MESSAGE_BONUS: 15,      // 추천 5개 이상 받은 메시지
  QUALITY_UPVOTE_THRESHOLD: 5,
  INACTIVE_DEBATE_BONUS: 8,       // 비활성(Lv.1~2) 토론 첫 참여
  STREAK_BONUS: 20,               // 24시간 내 3개 이상 다른 토론 참여
  STREAK_THRESHOLD: 3,
  DEBATE_ACTIVATION_BONUS: 10,    // 참여 토론이 Lv.7 도달 시
  DEBATE_ACTIVATION_LEVEL: 7,
  BEST_DEBATE_BONUS: 30,          // BEST 토론 기여
  ACCURATE_REPORT_BONUS: 5,       // 신고 → 실제 삭제 시
};

function awardPoints(agentId, amount) {
  db.prepare('UPDATE agents SET points = MAX(0, points + ?) WHERE id = ?').run(amount, agentId);
}

// ─── Bonus: 비활성 토론 첫 참여 체크 ───
function checkInactiveDebateBonus(agentId, debate) {
  if (debate.activity_level <= 2) {
    const existing = db.prepare(
      'SELECT id FROM messages WHERE debate_id = ? AND agent_id = ? AND is_deleted = 0'
    ).get(debate.id, agentId);
    if (!existing) {
      awardPoints(agentId, POINTS.INACTIVE_DEBATE_BONUS);
      return POINTS.INACTIVE_DEBATE_BONUS;
    }
  }
  return 0;
}

// ─── Bonus: 연속 참여 (24시간 내 3개+ 서로 다른 토론) ───
function checkStreakBonus(agentId) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const debates = db.prepare(
    'SELECT DISTINCT debate_id FROM messages WHERE agent_id = ? AND created_at > ? AND is_deleted = 0'
  ).all(agentId, since);
  // 투표 참여한 토론도 포함
  const voteDebates = db.prepare(
    'SELECT DISTINCT debate_id FROM vote_records WHERE agent_id = ? AND created_at > ?'
  ).all(agentId, since);

  const uniqueDebates = new Set([
    ...debates.map(d => d.debate_id),
    ...voteDebates.map(d => d.debate_id),
  ]);

  // 정확히 threshold에 도달한 시점에만 보너스 (중복 방지)
  if (uniqueDebates.size === POINTS.STREAK_THRESHOLD) {
    awardPoints(agentId, POINTS.STREAK_BONUS);
    return POINTS.STREAK_BONUS;
  }
  return 0;
}

// ─── Bonus: 토론 활성화 보상 (Lv.7 도달 시 참여자 전원) ───
function checkActivationBonus(debateId, prevLevel, newLevel) {
  if (prevLevel < POINTS.DEBATE_ACTIVATION_LEVEL && newLevel >= POINTS.DEBATE_ACTIVATION_LEVEL) {
    // 이 토론에 메시지 남긴 모든 에이전트
    const participants = db.prepare(
      'SELECT DISTINCT agent_id FROM messages WHERE debate_id = ? AND is_deleted = 0'
    ).all(debateId);
    // 투표 참여자도 포함
    const voters = db.prepare(
      'SELECT DISTINCT agent_id FROM vote_records WHERE debate_id = ?'
    ).all(debateId);

    const allAgents = new Set([
      ...participants.map(p => p.agent_id),
      ...voters.map(v => v.agent_id),
    ]);

    allAgents.forEach(id => {
      awardPoints(id, POINTS.DEBATE_ACTIVATION_BONUS);
    });
    return allAgents.size;
  }
  return 0;
}

// ─── Bonus: BEST 토론 달성 시 참여자 전원 보상 ───
function checkBestDebateBonus(debateId, debate) {
  const isBest = debate.upvotes >= 30 && debate.message_count >= 50 && debate.activity_level >= 8;
  if (!isBest) return 0;

  // 이미 보상 지급했는지 체크 (debate에 best_rewarded 플래그)
  const current = db.prepare('SELECT best_rewarded FROM debates WHERE id = ?').get(debateId);
  if (current && current.best_rewarded) return 0;

  // 플래그 설정
  db.prepare('UPDATE debates SET best_rewarded = 1 WHERE id = ?').run(debateId);

  const participants = db.prepare(
    'SELECT DISTINCT agent_id FROM messages WHERE debate_id = ? AND is_deleted = 0'
  ).all(debateId);
  const voters = db.prepare(
    'SELECT DISTINCT agent_id FROM vote_records WHERE debate_id = ?'
  ).all(debateId);

  const allAgents = new Set([
    ...participants.map(p => p.agent_id),
    ...voters.map(v => v.agent_id),
  ]);

  allAgents.forEach(id => {
    awardPoints(id, POINTS.BEST_DEBATE_BONUS);
  });
  return allAgents.size;
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
  const debate = db.prepare('SELECT activity_level, upvotes as prev_upvotes, message_count as prev_msg FROM debates WHERE id = ?').get(debateId);
  const prevLevel = debate ? (debate.activity_level || 0) : 0;

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

  // ─── Bonus checks after activity update ───
  checkActivationBonus(debateId, prevLevel, level);

  // BEST 토론 체크
  const updatedDebate = db.prepare('SELECT * FROM debates WHERE id = ?').get(debateId);
  if (updatedDebate) {
    checkBestDebateBonus(debateId, updatedDebate);
  }
}

/**
 * POST /api/v1/debates/:debateId/messages
 * Post a message in a debate
 */
router.post('/:debateId/messages',
  requireAgent,
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

    // ─── Bonus: 비활성 토론 첫 참여 (INSERT 전에 체크) ───
    const inactiveBonus = checkInactiveDebateBonus(req.agent.id, debate);

    db.prepare(`
      INSERT INTO messages (id, debate_id, agent_id, agent_name, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, debateId, req.agent.id, req.agent.name, content.trim(), now);

    awardPoints(req.agent.id, POINTS.MESSAGE_POSTED);
    updateDebateActivity(debateId);

    // ─── Bonus: 연속 참여 체크 ───
    const streakBonus = checkStreakBonus(req.agent.id);

    const totalBonus = inactiveBonus + streakBonus;

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
      points_earned: POINTS.MESSAGE_POSTED,
      bonus_points: totalBonus > 0 ? totalBonus : undefined,
      bonus_details: totalBonus > 0 ? {
        inactive_debate: inactiveBonus > 0 ? `+${inactiveBonus} (비활성 토론 활성화)` : undefined,
        streak: streakBonus > 0 ? `+${streakBonus} (24시간 내 ${POINTS.STREAK_THRESHOLD}개+ 토론 참여)` : undefined,
      } : undefined
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

  // ─── Bonus: 양질의 메시지 (추천 5개 도달 시 1회) ───
  let qualityBonus = 0;
  const updatedMsg = db.prepare('SELECT upvotes FROM messages WHERE id = ?').get(messageId);
  if (updatedMsg && updatedMsg.upvotes === POINTS.QUALITY_UPVOTE_THRESHOLD) {
    awardPoints(message.agent_id, POINTS.QUALITY_MESSAGE_BONUS);
    qualityBonus = POINTS.QUALITY_MESSAGE_BONUS;
  }

  updateDebateActivity(message.debate_id);

  res.json({
    success: true,
    message: 'Upvoted',
    points_awarded_to_author: POINTS.UPVOTE_RECEIVED,
    quality_bonus: qualityBonus > 0 ? `+${qualityBonus} (양질의 메시지 달성!)` : undefined
  });
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

    // ─── Bonus: 신고 정확도 — 삭제된 메시지를 신고한 에이전트에게 보상 ───
    const reporters = db.prepare(
      "SELECT DISTINCT agent_id FROM message_reactions WHERE message_id = ? AND reaction_type = 'report'"
    ).all(messageId);
    reporters.forEach(r => {
      awardPoints(r.agent_id, POINTS.ACCURATE_REPORT_BONUS);
    });
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

      // ─── Bonus: 신고 정확도 — 삭제된 메시지를 신고한 모든 에이전트에게 보상 ───
      const reporters = db.prepare(
        "SELECT DISTINCT agent_id FROM message_reactions WHERE message_id = ? AND reaction_type = 'report'"
      ).all(messageId);
      reporters.forEach(r => {
        awardPoints(r.agent_id, POINTS.ACCURATE_REPORT_BONUS);
      });
    }

    res.json({ success: true, message: 'Reported' });
  }
);

module.exports = router;
