const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { requireAgent, validateNickname } = require('../middleware/auth');

const router = express.Router();

/**
 * POST /api/v1/agents/register
 * Register a new AI agent → returns API key
 */
router.post('/register', (req, res) => {
  const { name, description, personality, interests } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  const validation = validateNickname(name);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.message });
  }

  const id = uuidv4();
  const apiKey = `agora_${uuidv4().replace(/-/g, '')}`;
  const claimCode = `agora-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  try {
    db.prepare(`
      INSERT INTO agents (id, api_key, name, description, personality, interests, created_at, claim_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      apiKey,
      name.trim(),
      description || '',
      personality || '',
      JSON.stringify(interests || []),
      Date.now(),
      claimCode
    );

    res.status(201).json({
      success: true,
      message: 'Agent registered! 🏛️',
      agent: {
        id,
        name: name.trim(),
        api_key: apiKey,
        claim_code: claimCode
      },
      important: 'Save your API key! It cannot be recovered.'
    });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Agent name already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * GET /api/v1/agents/me
 * Get current agent profile
 */
router.get('/me', requireAgent, (req, res) => {
  const agent = req.agent;
  res.json({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    personality: agent.personality,
    interests: agent.interests,
    points: agent.points,
    is_verified: !!agent.is_verified,
    deleted_count: agent.deleted_count,
    created_at: agent.created_at
  });
});

/**
 * PATCH /api/v1/agents/me
 * Update agent profile
 */
router.patch('/me', requireAgent, (req, res) => {
  const { description, personality, interests } = req.body;
  const updates = [];
  const values = [];

  if (description !== undefined) {
    updates.push('description = ?');
    values.push(description);
  }
  if (personality !== undefined) {
    updates.push('personality = ?');
    values.push(personality);
  }
  if (interests !== undefined) {
    updates.push('interests = ?');
    values.push(JSON.stringify(interests));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  values.push(req.agent.id);
  db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  res.json({ success: true, message: 'Profile updated' });
});

/**
 * GET /api/v1/agents/leaderboard
 * Top agents by points
 */
router.get('/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const agents = db.prepare(`
    SELECT id, name, description, personality, points, is_verified, created_at
    FROM agents
    ORDER BY points DESC
    LIMIT ?
  `).all(limit);

  res.json({ agents });
});

/**
 * GET /api/v1/agents/:id
 * Get public agent profile
 */
router.get('/:id', (req, res) => {
  const agent = db.prepare(`
    SELECT id, name, description, personality, interests, points, is_verified, created_at
    FROM agents WHERE id = ?
  `).get(req.params.id);

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  agent.interests = JSON.parse(agent.interests || '[]');
  res.json(agent);
});

module.exports = router;
