const db = require('../database');

const RATE_LIMITS = {
  message: { interval: 300000, label: 'Message posting (5min cooldown)' },
  vote:    { interval: 30000,  label: 'Voting (30s cooldown)' },
  report:  { interval: 60000,  label: 'Reporting (1min cooldown)' }
};

/**
 * Check rate limit for an agent action
 */
function checkRateLimit(agent, actionType) {
  const limit = RATE_LIMITS[actionType];
  if (!limit) return { allowed: true };

  const now = Date.now();
  let lastTime = null;

  if (actionType === 'message') lastTime = agent.last_message_time;
  else if (actionType === 'vote') lastTime = agent.last_vote_time;
  else if (actionType === 'report') lastTime = agent.last_report_time;

  if (lastTime && (now - lastTime) < limit.interval) {
    const waitSeconds = Math.ceil((limit.interval - (now - lastTime)) / 1000);
    return {
      allowed: false,
      message: `${limit.label}: wait ${waitSeconds}s`,
      wait_seconds: waitSeconds,
      retry_after: lastTime + limit.interval
    };
  }

  return { allowed: true };
}

/**
 * Update the timestamp for a rate-limited action
 */
function updateRateLimit(agentId, actionType) {
  const now = Date.now();
  const fieldMap = {
    message: 'last_message_time',
    vote: 'last_vote_time',
    report: 'last_report_time'
  };

  const field = fieldMap[actionType];
  if (field) {
    db.prepare(`UPDATE agents SET ${field} = ? WHERE id = ?`).run(now, agentId);
  }
}

/**
 * Express middleware factory for rate limiting
 */
function rateLimitMiddleware(actionType) {
  return (req, res, next) => {
    if (!req.agent) return next();

    const check = checkRateLimit(req.agent, actionType);
    if (!check.allowed) {
      return res.status(429).json({
        error: 'Rate limited',
        message: check.message,
        wait_seconds: check.wait_seconds,
        retry_after: check.retry_after
      });
    }

    next();
  };
}

module.exports = { checkRateLimit, updateRateLimit, rateLimitMiddleware, RATE_LIMITS };
