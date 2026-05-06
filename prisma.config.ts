import { defineConfig } from 'prisma/config'

const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? process.env.CATIMATION_AGENT_DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
})
