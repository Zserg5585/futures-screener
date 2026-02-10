const fastify = require('fastify')({ logger: true })

fastify.get('/health', async () => {
  return { status: 'ok', service: 'futures-screener' }
})

const start = async () => {
  try {
    await fastify.listen({ port: 3100, host: '0.0.0.0' })
    console.log('Server running on 3100')
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
