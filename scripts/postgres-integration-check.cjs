/* Isolated PostgreSQL-engine API regression: no developer credentials, data or email. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');
require('dotenv').config = () => ({ parsed: {} });

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'groundwork-postgres-flow-'));
  const root = path.resolve(__dirname, '..');
  const engine = new PGlite();
  let server, database;
  let tail = Promise.resolve();
  async function acquire() {
    const previous = tail; let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous; return release;
  }
  async function query(text, values = []) {
    if (text === 'COMMIT') await new Promise(resolve => setTimeout(resolve, 20));
    const result = await engine.query(text, values);
    for (const field of result.fields) if ([20, 1700].includes(field.dataTypeID)) {
      for (const row of result.rows) if (row[field.name] !== null) row[field.name] = String(row[field.name]);
    }
    return { rows: result.rows, fields: result.fields, command: result.command,
      rowCount: result.command === 'SELECT' ? result.rows.length : result.affectedRows, oid: 0 };
  }
  // Patch the CJS driver before its ESM namespace is created. Production uses real pg.Pool.
  require('pg').Pool = class extends EventEmitter {
    async query(text, values) { const release = await acquire(); try { return await query(text, values); } finally { release(); } }
    async connect() { const release = await acquire(); return { query, release }; }
    async end() {}
  };
  Object.assign(process.env, {
    NODE_ENV: 'test', BIND_HOST: '127.0.0.1', MASTER_KEY: randomBytes(32).toString('base64'),
    GROUNDWORK_DATA_DIR: directory, DATABASE_PROVIDER: 'supabase', DATABASE_URL: 'postgresql://fixture:fixture@localhost/test',
    DATABASE_ADMIN_URL: '', DATABASE_SSL_CA_FILE: '', PAYMENTS_MODE: 'demo', MAIL_PROVIDER: 'console',
    GROUNDWORK_DEV_OTP: '1', GROUNDWORK_SERVER_ROLE: 'authority', GROUNDWORK_AUTHORITY_GATEWAY_MODE: 'direct',
    NATIVE_WORKER_ENABLED: 'false', NATIVE_ISOLATION_ACKNOWLEDGED: 'false',
  });
  for (const key of ['DB_PATH','PREVIOUS_MASTER_KEY','SUPABASE_DB_URL','GROUNDWORK_AUTHORITY_URL','GROUNDWORK_SEED_DEMO',
    'AI_API_KEY','GEMINI_API_KEY','IMAGEN_API_KEY','RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET',
    'MAIL_HOST','MAIL_USER','MAIL_PASS','RESEND_API_KEY']) delete process.env[key];
  try {
    await engine.exec(fs.readFileSync(path.join(root, 'server/supabase/migrations/20261019191555_groundwork_private_database.sql'), 'utf8'));
    await engine.exec(fs.readFileSync(path.join(root, 'server/supabase/migrations/20261021153936_engineering_runtime.sql'), 'utf8'));
    await engine.exec(fs.readFileSync(path.join(root, 'server/supabase/migrations/20261104191702_native_worker_transport.sql'), 'utf8'));
    await engine.exec('SET ROLE groundwork_runtime');
    const load = file => import(pathToFileURL(path.join(root, file)).href);
    const [{ app }, { db, now }, { hashPassword }] = await Promise.all([
      load('server/src/index.ts'), load('server/src/db.ts'), load('server/src/crypto.ts'),
    ]);
    database = db;
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    class Client {
      cookies = new Map(); csrf = '';
      async request(method, endpoint, body) {
        const response = await fetch(base + endpoint, { method,
          headers: { 'content-type': 'application/json', cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [key,value] = cookie.split(';',1)[0].split('='); this.cookies.set(key,value);
        }
        const data = await response.json();
        if (data.csrfToken) this.csrf = data.csrfToken;
        return { status: response.status, data };
      }
    }
    const password = `Fixture-${randomBytes(16).toString('hex')}-1`;
    const hashed = hashPassword(password);
    for (const id of ['pg-owner','pg-other']) await db.prepare(`INSERT INTO users
      (id,email,username,email_verified,password_salt,password_hash,country,password_changed_at,created_at,updated_at)
      VALUES(?,?,?,1,?,?,'IN',?,?,?)`).run(id, `${id}@example.invalid`, id.replace('-','_'), hashed.salt, hashed.hash, now(), now(), now());
    const owner = new Client();
    assert.equal((await owner.request('POST','/api/auth/login',{ email:'PG-OWNER@EXAMPLE.INVALID', password })).status,200);
    assert.equal((await owner.request('GET','/api/auth/me')).data.user.id,'pg-owner');
    const created = await owner.request('POST','/api/projects',{ name:'PostgreSQL project',projectType:'house' });
    assert.equal(created.status,201,JSON.stringify(created.data));
    const id = created.data.id;
    const design = { version:1, walls:[], rooms:[], note:'private-fixture-design' };
    const saved = await owner.request('PATCH',`/api/projects/${id}`,{ designData:JSON.stringify(design),baseRevision:0 });
    assert.equal(saved.status,200,JSON.stringify(saved.data));
    const read = await owner.request('GET',`/api/projects/${id}`);
    assert.equal(read.status,200); assert.deepEqual(read.data.design,design);
    const stored = await db.prepare('SELECT design_data FROM projects WHERE id=?').get(id);
    assert(!stored.design_data.includes(design.note));
    const revision = await owner.request('POST',`/api/projects/${id}/revisions`,{ name:'Verified snapshot' });
    assert.equal(revision.status,201,JSON.stringify(revision.data));
    const link = await owner.request('POST',`/api/projects/${id}/share-links`,{ expiresInHours:1 });
    assert.equal(link.status,201,JSON.stringify(link.data));
    assert.equal((await new Client().request('GET',`/api/share/${link.data.token}`)).status,200);
    const other = new Client();
    assert.equal((await other.request('POST','/api/auth/login',{ email:'pg-other@example.invalid',password })).status,200);
    assert.equal((await other.request('GET',`/api/projects/${id}`)).status,404);
    const artifacts = new FormData(); artifacts.append('kind','geometry'); artifacts.append('file',new Blob(['{"meshes":[]}'],{type:'application/json'}),'scene.json');
    const upload = await fetch(`${base}/api/projects/${id}/workspaces/artifacts`,{method:'POST',headers:{cookie:[...owner.cookies].map(([k,v])=>`${k}=${v}`).join('; '),'x-csrf-token':owner.csrf},body:artifacts});
    assert.equal(upload.status,201,await upload.text());
    const budgets = await load('server/src/providerBudget.ts');
    const permit = await budgets.admitProviderRequest({userId:'pg-owner',kind:'assistant',tokenBudget:1});
    await budgets.releaseProviderPermit(permit);
    assert.equal((await owner.request('GET','/api/audit?limit=10')).status,200);
    assert.equal((await owner.request('POST','/api/admin/backups',{})).status,501);
    assert.equal((await owner.request('POST','/api/auth/logout',{})).status,200);
    assert.equal((await owner.request('GET','/api/auth/me')).status,401);
    console.log('PostgreSQL API checks passed: committed sign-in, encrypted project save/reload, history, sharing, tenant isolation, binary upload, provider budget, audit, managed backup response and logout. All data was synthetic.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (database) await (await import('../server/src/telemetry.ts')).drainTelemetry();
    await database?.close(); await engine.close();
    const canonical=fs.realpathSync(directory);
    assert(path.dirname(canonical).toLowerCase()===fs.realpathSync(os.tmpdir()).toLowerCase()&&path.basename(canonical).startsWith('groundwork-postgres-flow-'));
    fs.rmSync(canonical,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
