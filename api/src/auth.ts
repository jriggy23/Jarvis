import { NextFunction, Request, Response } from "express";

/**
 * Auth middleware — v1 NO-OP pass-through stub.
 *
 * TODO(v1): validate Entra ID token. The SPA acquires an Entra ID (OIDC) token
 * and sends it as `Authorization: Bearer <jwt>`; this middleware must validate
 * the signature/issuer/audience and reject anonymous requests (plan §6). For
 * now every request is allowed through so the rest of the contract can be built
 * and tested.
 */
export function authStub(_req: Request, _res: Response, next: NextFunction): void {
  // TODO(v1): validate Entra ID token before calling next().
  next();
}
