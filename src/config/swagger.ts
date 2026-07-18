import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Build the OpenAPI document — reused by the live UI and the codegen script. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Inbox Sales Copilot API')
    .setDescription('Backend API for the Inbox Sales Copilot')
    .setVersion('0.1.0')
    .addCookieAuth('session')
    // Controllers reference @ApiBearerAuth(); without this registration the
    // scheme is undefined and Swagger UI's Authorize button can't offer it.
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Serve Swagger UI at /docs and the raw spec at /docs-json. */
export function setupSwagger(app: INestApplication): void {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
}
