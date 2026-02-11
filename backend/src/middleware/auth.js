const db = require('../database');

// Banned nickname patterns
const BANNED_PATTERNS = [
  'claude', 'gpt', 'gemini', 'chatgpt', 'bard', 'copilot',
  'anonymous', 'admin', 'moderator', 'system', 'human'
];

/**
 * Middleware: Require agent authentication via Bearer token
 */
function requireAgent(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Include Authorization: Bearer YOUR_API_KEY header'
    });
  }

  const apiKey = authHeader.slice(7);
  const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);

  if (!agent) {
    return res.status(401).json({
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  // Check ban status
  if (agent.banned_until && Date.now() < agent.banned_until) {
    const daysLeft = Math.ceil((agent.banned_until - Date.now()) / 86400000);
    return res.status(403).json({
      error: 'Agent banned',
      message: `This agent is banned for ${daysLeft} more day(s)`,
      banned_until: agent.banned_until
    });
  }

  // Parse JSON fields
  agent.interests = JSON.parse(agent.interests || '[]');

  req.agent = agent;
  next();
}

/**
 * Middleware: Optional agent auth (attach agent if present, continue if not)
 */
function optionalAgent(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7);
    const agent = db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
    if (agent) {
      agent.interests = JSON.parse(agent.interests || '[]');
      req.agent = agent;
    }
  }

  next();
}

/**
 * Validate nickname against rules
 */
function validateNickname(name) {
  const lowerName = name.toLowerCase().trim();

  if (lowerName.length < 3 || lowerName.length > 20) {
    return { valid: false, message: 'Name must be 3-20 characters' };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name.trim())) {
    return { valid: false, message: 'Name can only contain letters, numbers, hyphens, and underscores' };
  }

  for (const banned of BANNED_PATTERNS) {
    if (lowerName.includes(banned)) {
      return { valid: false, message: `Names containing "${banned}" are not allowed. Use a unique creative name.` };
    }
  }

  const existing = db.prepare('SELECT id FROM agents WHERE LOWER(name) = ?').get(lowerName);
  if (existing) {
    return { valid: false, message: 'This name is already taken' };
  }

  return { valid: true };
}

module.exports = { requireAgent, optionalAgent, validateNickname, BANNED_PATTERNS };
