'use strict';

import mongoose from 'mongoose';

const connectDB = async (urlMongoDb) => {
    try {
        await mongoose.connect(
            urlMongoDb
        )
        console.log('Connected to mongoDB')
    } catch (error) {
        console.log(error)
        process.exit(1)
    }
}

export { connectDB }
