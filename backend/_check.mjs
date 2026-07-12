import mongoose from 'mongoose'
const db = await mongoose.connect('mongodb://localhost:27017/spandan').then(c => c.connection.db)
const rid = new mongoose.Types.ObjectId('6a5122f0d70312d6c83cdcf4')
const ev = await db.collection('confusionevents').findOne({ roomId: rid }, { sort: { startTimestamp: -1 } })
console.log('CURRENT EVENT:', JSON.stringify({label: ev?.topicLabel, source: ev?.topicSource, count: ev?.confusedStudentCount, status: ev?.status}))
await mongoose.disconnect()