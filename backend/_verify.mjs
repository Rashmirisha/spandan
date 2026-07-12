import mongoose from 'mongoose'
const db = await mongoose.connect('mongodb://localhost:27017/spandan').then(c => c.connection.db)
const rid = new mongoose.Types.ObjectId('6a5122f0d70312d6c83cdcf4')
await db.collection('confusionevents').deleteMany({ roomId: rid })
await db.collection('topicmarkers').deleteMany({ roomId: rid })
await db.collection('transcripts').deleteMany({ roomId: rid })
await db.collection('doubtsignals').deleteMany({ roomId: rid })
console.log('CLEARED')
await mongoose.disconnect()