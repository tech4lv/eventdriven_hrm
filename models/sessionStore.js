/*
  MySQL-backed express-session store. Keeps sessions in the `sessions`
  table so logins survive server restarts and work across multiple
  processes (unlike the default in-memory store).
*/
import session from "express-session";
import { DataTypes, Op } from "sequelize";
import { sequelize } from "./db.js";

export const Session = sequelize.define(
  "Session",
  {
    sid: { type: DataTypes.STRING(128), primaryKey: true },
    data: { type: DataTypes.TEXT("medium"), allowNull: false },
    expires: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "sessions",
    timestamps: false,
    indexes: [{ fields: ["expires"] }],
  },
);

class SequelizeStore extends session.Store {
  get(sid, cb) {
    Session.findByPk(sid)
      .then((row) => {
        if (!row) return cb(null, null);
        if (row.expires && new Date(row.expires) < new Date())
          return cb(null, null);
        try {
          cb(null, JSON.parse(row.data));
        } catch (e) {
          cb(e);
        }
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : null;
    Session.upsert({ sid, data: JSON.stringify(sess), expires })
      .then(() => cb(null))
      .catch(cb);
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : null;
    Session.update({ data: JSON.stringify(sess), expires }, { where: { sid } })
      .then(() => cb(null))
      .catch(cb);
  }

  destroy(sid, cb) {
    Session.destroy({ where: { sid } })
      .then(() => cb(null))
      .catch(cb);
  }
}

/** Creates the sessions table if missing (non-destructive) and returns the store. */
export async function createSessionStore() {
  await Session.sync();
  // prune expired rows every 6 hours
  setInterval(
    () => pruneSessions().catch(() => {}),
    6 * 60 * 60 * 1000,
  ).unref();
  return new SequelizeStore();
}

/** Removes expired session rows; safe to call periodically. */
export async function pruneSessions() {
  await Session.destroy({ where: { expires: { [Op.lt]: new Date() } } });
}

export default SequelizeStore;
