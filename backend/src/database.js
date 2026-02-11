const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './data/ai-agora.json';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Load or initialize
let data = {
  agents: [],
  debates: [],
  messages: [],
  vote_records: [],
  message_reactions: []
};

if (fs.existsSync(DB_PATH)) {
  try { data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { console.log('Starting fresh DB'); }
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Minimal SQL-like wrapper to keep routes working
const db = {
  _data: data,
  _save: save,

  prepare(sql) {
    return {
      run: (...params) => db._exec(sql, params, 'run'),
      get: (...params) => db._exec(sql, params, 'get'),
      all: (...params) => db._exec(sql, params, 'all')
    };
  },

  exec() { /* schema handled by JSON structure */ },

  pragma() { },

  _exec(sql, params, mode) {
    const sqlLower = sql.toLowerCase().trim();

    // ─── INSERT ───
    if (sqlLower.startsWith('insert into')) {
      const table = sql.match(/insert\s+into\s+(\w+)/i)?.[1];
      if (!table || !data[table + 's'] && !data[table]) return { changes: 0 };
      const collection = data[table + 's'] || data[table];

      const colMatch = sql.match(/\(([^)]+)\)\s*values/i);
      if (!colMatch) return { changes: 0 };
      const cols = colMatch[1].split(',').map(c => c.trim());

      const row = {};
      cols.forEach((col, i) => { row[col] = params[i]; });

      // Check UNIQUE constraints
      if (table === 'agent' || table === 'agents') {
        const arr = data.agents;
        if (arr.find(a => a.api_key === row.api_key)) throw new Error('UNIQUE constraint: api_key');
        if (arr.find(a => a.name === row.name)) throw new Error('UNIQUE constraint: name');
      }
      if (table === 'vote_record' || table === 'vote_records') {
        const arr = data.vote_records;
        if (arr.find(v => v.debate_id === row.debate_id && v.agent_id === row.agent_id))
          throw new Error('UNIQUE constraint: vote');
      }
      if (table === 'message_reaction' || table === 'message_reactions') {
        const arr = data.message_reactions;
        if (arr.find(r => r.message_id === row.message_id && r.agent_id === row.agent_id && r.reaction_type === row.reaction_type))
          throw new Error('UNIQUE constraint: reaction');
      }

      collection.push(row);
      save();
      return { changes: 1 };
    }

    // ─── SELECT ───
    if (sqlLower.startsWith('select')) {
      let results = [];

      // Determine table
      const fromMatch = sql.match(/from\s+(\w+)/i);
      if (!fromMatch) return mode === 'all' ? [] : null;
      let table = fromMatch[1];

      // Handle JOINs by working with the primary table
      let collection = data[table] || [];

      // Clone for filtering
      results = [...collection];

      // WHERE clauses
      const whereMatch = sql.match(/where\s+(.+?)(?:\s+order|\s+limit|\s+group|\s*$)/is);
      if (whereMatch) {
        const whereParts = whereMatch[1];
        let paramIdx = 0;

        // Extract conditions
        const conditions = whereParts.split(/\s+and\s+/i);
        results = results.filter(row => {
          return conditions.every(cond => {
            const cTrimmed = cond.trim();

            // Handle table prefix (e.g., m.debate_id)
            const cleanCond = cTrimmed.replace(/\w+\./g, '');

            if (cleanCond.match(/(\w+)\s*=\s*\?/)) {
              const field = cleanCond.match(/(\w+)\s*=\s*\?/)[1];
              const val = params[paramIdx++];
              return row[field] == val;
            }
            if (cleanCond.match(/(\w+)\s+like\s+\?/i)) {
              const field = cleanCond.match(/(\w+)\s+like\s+\?/i)[1];
              const pattern = params[paramIdx++];
              const regex = new RegExp(pattern.replace(/%/g, '.*'), 'i');
              return regex.test(row[field] || '');
            }
            if (cleanCond.match(/(\w+)\s+is\s+not\s+null/i)) {
              const field = cleanCond.match(/(\w+)\s+is\s+not\s+null/i)[1];
              return row[field] != null;
            }
            if (cleanCond.match(/lower\((\w+)\)\s*=\s*\?/i)) {
              const field = cleanCond.match(/lower\((\w+)\)\s*=\s*\?/i)[1];
              const val = params[paramIdx++];
              return (row[field] || '').toLowerCase() === val;
            }
            return true;
          });
        });
      }

      // COUNT
      if (sqlLower.includes('count(*)')) {
        const result = { count: results.length };
        return mode === 'get' ? result : [result];
      }

      // SUM
      const sumMatch = sql.match(/sum\((\w+)\)/i);
      if (sumMatch) {
        const field = sumMatch[1];
        const total = results.reduce((s, r) => s + (Number(r[field]) || 0), 0);
        return mode === 'get' ? { total } : [{ total }];
      }

      // COUNT DISTINCT
      if (sqlLower.includes('count(distinct')) {
        const distinctField = sql.match(/count\(distinct\s+(\w+)\)/i)?.[1];
        if (distinctField) {
          const unique = new Set(results.map(r => r[distinctField]));
          return mode === 'get' ? { unique_agents: unique.size, msg_count: results.length } : [{ unique_agents: unique.size }];
        }
      }

      // DISTINCT
      if (sqlLower.includes('select distinct')) {
        const seen = new Set();
        results = results.filter(r => {
          const key = r.agent_id || r.id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      // JOIN enrichment
      if (sqlLower.includes('join agents')) {
        results = results.map(r => {
          const agent = data.agents.find(a => a.id === r.agent_id);
          return agent ? { ...r, personality: agent.personality, is_verified: agent.is_verified, agent_points: agent.points } : r;
        });
      }

      // ORDER BY
      const orderMatch = sql.match(/order\s+by\s+(.+?)(?:\s+limit|\s*$)/is);
      if (orderMatch) {
        const orderStr = orderMatch[1].trim();
        const parts = orderStr.split(',')[0].trim().split(/\s+/);
        const field = parts[0].replace(/\w+\./, '');
        const desc = (parts[1] || '').toUpperCase() === 'DESC';
        results.sort((a, b) => {
          const va = a[field] ?? 0, vb = b[field] ?? 0;
          return desc ? (vb > va ? 1 : -1) : (va > vb ? 1 : -1);
        });
      }

      // LIMIT / OFFSET
      const limitMatch = sql.match(/limit\s+\?/i);
      const offsetMatch = sql.match(/offset\s+\?/i);
      if (limitMatch) {
        const limitIdx = params.length - (offsetMatch ? 2 : 1);
        const limit = params[limitIdx];
        const offset = offsetMatch ? params[limitIdx + 1] : 0;
        results = results.slice(offset, offset + limit);
      }

      // Select specific fields
      const selectMatch = sql.match(/select\s+(.+?)\s+from/is);
      if (selectMatch && !selectMatch[1].includes('*')) {
        const fields = selectMatch[1].split(',').map(f =>
          f.trim().replace(/\w+\./, '').replace(/\s+as\s+\w+/i, '').trim()
        ).filter(f => !f.includes('('));
        if (fields.length > 0 && fields[0] !== '') {
          // Keep all fields for simplicity, the routes handle what they need
        }
      }

      if (mode === 'get') return results[0] || null;
      return results;
    }

    // ─── UPDATE ───
    if (sqlLower.startsWith('update')) {
      const table = sql.match(/update\s+(\w+)/i)?.[1];
      const collection = data[table] || [];

      // Parse SET
      const setMatch = sql.match(/set\s+(.+?)\s+where/is);
      if (!setMatch) return { changes: 0 };

      // Parse WHERE
      const whereMatch = sql.match(/where\s+(.+)/is);
      let paramIdx = 0;

      // Count ? in SET clause
      const setClause = setMatch[1];
      const setParts = setClause.split(',').map(s => s.trim());

      const updates = {};
      setParts.forEach(part => {
        const eqMatch = part.match(/(\w+)\s*=\s*(.+)/);
        if (!eqMatch) return;
        const field = eqMatch[1];
        const valExpr = eqMatch[2].trim();

        if (valExpr === '?') {
          updates[field] = { type: 'set', value: params[paramIdx++] };
        } else if (valExpr.match(/\w+\s*\+\s*1/)) {
          updates[field] = { type: 'increment', by: 1 };
        } else if (valExpr.match(/\w+\s*-\s*1/)) {
          updates[field] = { type: 'increment', by: -1 };
        } else if (valExpr.match(/max\s*\(\s*0\s*,\s*\w+\s*\+\s*\?\s*\)/i)) {
          updates[field] = { type: 'add_floor', value: params[paramIdx++] };
        }
      });

      // WHERE matching
      let changes = 0;
      if (whereMatch) {
        const whereField = whereMatch[1].match(/(\w+)\s*=\s*\?/)?.[1];
        const whereVal = params[paramIdx];

        collection.forEach(row => {
          if (row[whereField] == whereVal) {
            Object.entries(updates).forEach(([field, op]) => {
              if (op.type === 'set') row[field] = op.value;
              else if (op.type === 'increment') row[field] = (row[field] || 0) + op.by;
              else if (op.type === 'add_floor') row[field] = Math.max(0, (row[field] || 0) + op.value);
            });
            changes++;
          }
        });
      }

      save();
      return { changes };
    }

    return mode === 'all' ? [] : mode === 'get' ? null : { changes: 0 };
  }
};

module.exports = db;