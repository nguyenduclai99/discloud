'use strict';

import { upload, fileDetail, files } from "./controllers/DiscloudController.js";

const routes = (app) => {
    app.route('/api/v1/discloud').get(files);
    app.route('/api/v1/discloud').post(upload);
    app.route(["/v1/file/:id/*", "/v1/file/:id"]).get(fileDetail);
}

export default routes;