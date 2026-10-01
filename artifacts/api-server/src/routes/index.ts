import { Router, type IRouter } from "express";
import healthRouter from "./health";
import adminRouter from "./admin";
import processesRouter from "./processes";
import storageRouter from "./storage";
import telegramRouter from "./telegram";

const router: IRouter = Router();

router.use(healthRouter);
router.use(processesRouter);
router.use(adminRouter);
router.use(storageRouter);
router.use(telegramRouter);

export default router;
