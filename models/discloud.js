import mongoose from 'mongoose';

const discloud = new mongoose.Schema({
    file_id: {
        type: String
    },
    chunk_size: {
        type: Number,
    },
    file_name: {
        type: String,
    },
    file_size: {
        type: Number,
    },
    parts: {
        type: Array,
    },
    created_at: {
        type: String,
    }
})

const discloudApi = mongoose.model("discloud", discloud);

export { discloudApi }
