'use strict';

import axios from "axios";
import { discloudApi } from "../models/discloud.js";
import { uploadToDiscord } from "../services/discord.js";
import { randomId } from "../utils/id.js";
import { AsyncStreamProcessor } from "../utils/stream.js";
import { formatFileName } from "../utils/string.js";
import { wait } from "../utils/time.js";
import dotenv from "dotenv";
dotenv.config();

// Constants
const CHUNK_SIZE = 8388608; // 8 MB
const RANGE_SIZE = 5242880; // 5 MB
const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_CHANNEL_ID;

const upload = async (req, res) => {
    try {
        let chunks = [];
        let uploadedParts = [];
        let fill = 0;
        let uploadedCount = 0;
        let requestEnded = false;
        let fileSize = 0;
        let filesToUpload = [];

        if (!req.query.fileName)
            return res.status(400).send({
                message: "Missing fileName query param",
            });

        const fileName = formatFileName(req.query.fileName);
        req.on("data", (chunk) => {
            chunks.push(chunk);

            // Current length of total chunks
            fill += chunk.length;

            fileSize += chunk.length;

            // While current length is greater than max chunk size
            // Use while instead of if because there can be chunks that are twice or three times bigger than the max chunk size
            while (fill >= CHUNK_SIZE) {
                // Create a new chunk with that exact size
                const newChunk = Buffer.concat(chunks, CHUNK_SIZE);

                // Get the residue of the last chunk after creating a new chunk
                const lastChunk = chunks.slice(-1)[0];
                const residueLength = fill - CHUNK_SIZE;

                // Set the chunks arr with the remaining from the last chunk
                chunks =
                    residueLength === 0 ?
                    [] :
                    [Buffer.from(lastChunk.slice(-residueLength))];

                fill = residueLength;

                filesToUpload.push(newChunk);
            }
        });
        
        req.on("end", async () => {
            // Add the final chunks if there is any left-over
            requestEnded = true;
            if (chunks.length > 0) {
                const newChunk = Buffer.concat(chunks);

                filesToUpload.push(newChunk);
            }
        });

        while (filesToUpload.length > 0 || !requestEnded) {
            if (filesToUpload.length === 0) {
                await wait(200);
            } else {
                const url = await uploadToDiscord(
                    token,
                    channelId,
                    filesToUpload.splice(0, 1)[0],
                    `${fileName}-chunk-${++uploadedCount}`
                );
                uploadedParts.push(url);
                
            }
        }

        const fileId = randomId();
        const discloud = new discloudApi({
            file_id: fileId,
            chunk_size: CHUNK_SIZE,
            file_name: fileName,
            file_size: fileSize,
            parts: uploadedParts,
            created_at: new Date().toISOString(),
        });

        await discloud.save()
        .then(doc => {
            res.status(200).send({
                code: 200,
                message: "Success",
                data: {
                    fileId,
                    fileSize,
                    url: `${req.get('origin')}/v1/file/${fileId}`,
                    longURL: `${req.get('origin')}/v1/file/${fileId}/${fileName}`,
                    downloadURL: `${req.get('origin')}/v1/file/${fileId}?download=1`,
                    longDownloadURL: `${req.get('origin')}/v1/file/${fileId}/${fileName}?download=1`,
                    parts: uploadedParts,
                },
            })
        })
        .catch(err => {
            res.status(400).send({
                code: 400,
                message: err?.response?.data ? err.response.data : err,
                data: null
            })
            console.error(err)
        })
    } catch (error) {
        if (!res.headersSent)
            res.status(500).send({
                message: "Internal server error",
                error,
            });
            
    }
}

const fileDetail = async (req, res) => {
    try {
        let info = await discloudApi.findOne({file_id: req.params.id});

        if (!info) return res.status(404).send("Cannot find the specified file");

        res.setHeader("Content-Length", info.file_size);
        res.setHeader("Accept-Ranges", "bytes");

        if (+req.query.download) {
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${info.file_name}"`
            );
        }

        res.contentType(info.file_name.split(".").slice(-1)[0]);

        // Parse the range header if client is requesting a video
        const rangeStr = req.headers.range;

        const start = rangeStr ? +rangeStr.split("=")[1].split("-")[0] : null;

        const end = rangeStr ?
            start + RANGE_SIZE >= info.file_size - 1 ?
            info.file_size - 1 :
            start + RANGE_SIZE :
            null;

        const partsToDownload = rangeStr ?
            (() => {
                const startPartNumber = Math.ceil(start / info.chunk_size) ?
                    Math.ceil(start / info.chunk_size) - 1 :
                    0;
                const endPartNumber = Math.ceil(end / info.chunk_size);

                const partsToDownload = info.parts
                    .map((part) => ({
                        url: part
                    }))
                    .slice(startPartNumber, endPartNumber);

                partsToDownload[0].start = start % info.chunk_size;
                partsToDownload[partsToDownload.length - 1].end =
                    end % info.chunk_size;

                res.status(206);
                res.setHeader("Content-Length", end - start + 1);
                res.setHeader(
                    "Content-Range",
                    `bytes ${start}-${end}/${info.file_size}`
                );

                return partsToDownload;
            })() :

            info.parts.map((part) => ({
                url: part
            }));

        for (const part of partsToDownload) {
            // Discord CDN supports range, so we will use that to chunk the file first
            const headers =
                part.start || part.end ?
                {
                    Range: `bytes=${part.start || 0}-${part.end || ""}`
                } :
                {};

            await new Promise((resolve, reject) => {
                axios
                    .get(part.url, {
                        headers,
                        responseType: "stream"
                    })
                    .then((response) => {
                        response.data.pipe(
                            new AsyncStreamProcessor(async (data) => {
                                if (!res.write(data))
                                    await new Promise((r) => res.once("drain", r));
                            })
                        );
                        response.data.on("error", (err) => reject(err));
                        response.data.on("end", () => resolve());
                    });
            });
        }

        res.end();
    } catch (error) {
        if (!res.headersSent)
            res.status(500).send({
                message: "Internal server error",
                error,
            });
    }
}

const files = async (req, res) => {
    try {
        let limit = req.query.limit
        let page = req.query.page
        let file_id = req.query.file_id
        let file_name = req.query.file_name
        let skip = 0;

        let params = {
            file_id,
            file_name,
        }
    
        for (const key in params) {
            if (params[key] === undefined) {
              delete params[key];
            }
        }
    
        if (!limit) limit = 10;
        if (!page || page == 0) {
            page = 1
            skip = 0
        } else {
            skip = limit * (page - 1)
        };

        let total = await discloudApi.find(params).count()
        await discloudApi.find(params)
        .limit(limit)
        .skip(skip)
        .then(docs => {
            res.status(200).send({
                code: 200,
                message: "Success",
                data: docs,
                total: total,
                page: parseInt(page),
                next_page: parseInt(page) + 1,
                limit: parseInt(limit),
                total_page: Math.ceil(total/limit),
            })
        })
        .catch(err => {
            res.status(500).send({
                code: 500,
                message: err.message,
                data: null,
                total: 0,
                page: parseInt(page),
                next_page: parseInt(page),
                limit: parseInt(limit),
                total_page: 0,
            })
        })
    } catch (error) {
        res.status(500).send({
            code: 500,
            message: error.message,
            data: null,
            total: 0,
            page: parseInt(page),
            next_page: parseInt(page),
            limit: parseInt(limit),
            total_page: 0,
        })
    }
}

export { upload, fileDetail, files };