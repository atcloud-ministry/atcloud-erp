import type { Request, Response } from "express";
import { parseAlumniDirectoryQuery } from "../../contracts/alumniDirectoryFlow";
import {
  alumniDirectoryService,
  type AlumniDirectoryService,
} from "../../services/alumni/AlumniDirectoryService";
import { sendAlumniHttpError } from "./AlumniHttpErrorResponder";
import {
  getAlumniRequestActor,
  setAlumniNoStore,
} from "./AlumniHttpRequestContext";

export class AlumniDirectoryController {
  constructor(
    private readonly service: AlumniDirectoryService = alumniDirectoryService,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const data = await this.service.list(parseAlumniDirectoryQuery(req.query));
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  get = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const profile = await this.service.get(req.params.profileId);
      res.status(200).json({ success: true, data: { profile } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };

  connection = async (req: Request, res: Response): Promise<void> => {
    setAlumniNoStore(res);
    try {
      const actor = getAlumniRequestActor(req, "help");
      const connection = await this.service.viewerConnection(
        actor.id,
        req.params.profileId,
      );
      res.status(200).json({ success: true, data: { connection } });
    } catch (error) {
      sendAlumniHttpError(res, error);
    }
  };
}

export const alumniDirectoryController = new AlumniDirectoryController();
