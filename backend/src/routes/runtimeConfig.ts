import { Router } from "express";
import { featureControlController } from "../controllers/runtime/FeatureControlController";

const router = Router();

router.get("/", featureControlController.getRuntimeConfig);

export default router;
