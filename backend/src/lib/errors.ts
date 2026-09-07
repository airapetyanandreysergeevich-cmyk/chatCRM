import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "./env";

export class AppError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const badRequest = (m: string, code?: string) => new AppError(400, m, code);
export const unauthorized = (m = "Не авторизован") => new AppError(401, m);
export const forbidden = (m = "Недостаточно прав") => new AppError(403, m);
export const notFound = (m = "Не найдено") => new AppError(404, m);
export const conflict = (m: string) => new AppError(409, m);

/** Оборачивает асинхронный обработчик, чтобы отказ промиса дошёл до обработчика ошибок. */
export function ah<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: T, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Проверьте заполнение полей",
      fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  req.log?.error({ err }, "необработанная ошибка");
  const message = env.nodeEnv === "production" ? "Внутренняя ошибка" : String((err as Error)?.message ?? err);
  res.status(500).json({ error: message });
}
