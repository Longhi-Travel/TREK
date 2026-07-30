import { Module } from '@nestjs/common';
import { BrandingController } from './branding.controller';

@Module({ controllers: [BrandingController] })
export class BrandingModule {}
