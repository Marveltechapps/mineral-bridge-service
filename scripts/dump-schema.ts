/**
 * Prints every registered Mongoose model with its collection and indexes (Markdown).
 * Used to refresh the tables in docs/DATABASE.md:   npx tsx scripts/dump-schema.ts
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const { default: mongoose } = await import('mongoose');
await Promise.all([
  import('../src/models/trading.models.js'),
  import('../src/models/finance.models.js'),
  import('../src/models/people.models.js'),
  import('../src/models/content.models.js'),
  import('../src/models/platform.models.js'),
  import('../src/modules/audit/audit.model.js'),
  import('../src/modules/auth/auth.models.js'),
  import('../src/modules/reference/reference.model.js'),
  import('../src/modules/staff/staff.model.js'),
  import('../src/modules/sessions/session.model.js'),
]);

const rows: string[] = ['| Model | Collection | Indexes |', '|---|---|---|'];
for (const name of mongoose.modelNames().sort()) {
  const model = mongoose.model(name);
  const schema = model.schema;
  const indexes = schema.indexes().map(([fields, opts]) => `\`${JSON.stringify(fields)}\`${opts?.unique ? ' unique' : ''}${opts?.partialFilterExpression ? ' partial' : ''}${opts?.expireAfterSeconds !== undefined ? ' ttl' : ''}`);
  rows.push(`| ${name} | ${model.collection.name} | ${indexes.join('<br>') || '—'} |`);
}
console.log(rows.join('\n'));
process.exit(0);
