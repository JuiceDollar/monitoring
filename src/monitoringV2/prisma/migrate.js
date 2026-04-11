const { execSync } = require('child_process');

const SCHEMA = './src/monitoringV2/prisma/schema.prisma';
const BASELINE = '0001_baseline';

function deploy() {
  return execSync(`npx prisma migrate deploy --schema=${SCHEMA}`, { encoding: 'utf-8' });
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

try {
  console.log(deploy());
} catch (error) {
  const output = (error.stdout || '') + (error.stderr || '');
  if (output.includes('P3005')) {
    console.log('Existing database detected — baselining migration history...');
    run(`npx prisma migrate resolve --applied ${BASELINE} --schema=${SCHEMA}`);
    console.log(deploy());
  } else {
    console.error(output);
    process.exit(error.status || 1);
  }
}
