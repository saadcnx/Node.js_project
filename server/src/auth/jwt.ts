import { NextFunction, Request, Response } from 'express';

export const requireJwt = (secret: string) => (req: Request, res: Response, next: NextFunction) => {
  const h = req.header('authorization') ?? '';
  if (!secret || !h.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};