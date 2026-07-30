import { Controller, Get, Header } from '@nestjs/common';
import { brandingPayload } from '../../services/branding';

/**
 * GET /api/branding — public, unauthenticated white-label configuration.
 * Returns only the env-set values ({} on a stock install); the shared page and
 * PDF export read it to apply the operator's brand. Cacheable: the values are
 * fixed for the process lifetime.
 */
@Controller('api/branding')
export class BrandingController {
  @Get()
  @Header('Cache-Control', 'public, max-age=300')
  get(): Record<string, string> {
    return brandingPayload();
  }
}
