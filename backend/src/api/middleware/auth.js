const jwt = require('jsonwebtoken');
const db  = require('../../db');

const JWT_SECRET   = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES  = process.env.ADMIN_JWT_EXPIRES_IN || '8h';

/**
 * Sign a JWT for an admin session.
 */
function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin.id, email: admin.email, role: admin.role, type: 'admin' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

/**
 * Sign a JWT for a Mini App user session.
 */
function signUserToken(user) {
  return jwt.sign(
    { sub: user.id, telegramId: user.telegram_id, type: 'user' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/**
 * Express middleware: require a valid admin JWT.
 */
async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.type !== 'admin') throw new Error('Not an admin token');

    const result = await db.query(
      'SELECT id, name, email, role, is_active FROM admins WHERE id = $1',
      [payload.sub]
    );
    if (!result.rows[0] || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Admin not found or inactive' });
    }

    req.admin = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Express middleware: require a valid admin JWT + specific role.
 */
function requireRole(...roles) {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET || 'dev-secret');
      if (payload.type !== 'admin') throw new Error();
      const result = await db.query('SELECT * FROM admins WHERE id=$1 AND is_active=true', [payload.sub]);
      if (!result.rows[0]) return res.status(401).json({ error: 'Admin not found' });
      req.admin = result.rows[0];
      if (!roles.includes(req.admin.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch(err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

/**
 * Express middleware: require a valid user (Mini App) JWT.
 */
async function requireUser(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.type !== 'user') throw new Error('Not a user token');

    const result = await db.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });

    req.user = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAdmin, requireUser, requireRole, signAdminToken, signUserToken };
