import { Readable } from "node:stream";
import { RequestUploadUrlBody, RequestUploadUrlResponse } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { requireUser } from "../middlewares/tribunalAuth";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();

router.post(
  "/storage/uploads/request-url",
  requireUser,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Dados do arquivo inválidos." });
      return;
    }
    const { name, size, contentType } = parsed.data;
    if (
      size > 25_000_000 ||
      name.includes("/") ||
      name.includes("\\") ||
      name.trim().length === 0 ||
      !/^(image\/(jpeg|png|webp)|application\/pdf|text\/plain|video\/mp4)$/.test(contentType)
    ) {
      res.status(400).json({ error: "Tipo, nome ou tamanho de arquivo não permitido." });
      return;
    }

    try {
      const uploadURL = await storage.getObjectEntityUploadURL();
      const objectPath = storage.normalizeObjectEntityPath(uploadURL);
      res.json(RequestUploadUrlResponse.parse({ uploadURL, objectPath }));
    } catch (error) {
      req.log.error({ err: error }, "Unable to create evidence upload URL");
      res.status(500).json({ error: "Não foi possível preparar o envio do arquivo." });
    }
  },
);

router.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const file = await storage.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: "Arquivo não encontrado." });
        return;
      }
      const response = await storage.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, "Unable to serve public object");
      res.status(500).json({ error: "Não foi possível exibir o arquivo." });
    }
  },
);

export default router;