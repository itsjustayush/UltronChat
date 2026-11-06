import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_OWXEgl2ae7HC@ep-wandering-voice-bbgycfts-pooler.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require';

async function test() {
  const sql = neon(DATABASE_URL);
  const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
  console.log('Neon connected successfully! Tables:', tables);
}

test().catch(console.error);
