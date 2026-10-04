-- Snapland GIS initial schema.
-- Generated with `prisma migrate diff`, then extended with PostGIS-specific DDL
-- that Prisma cannot express (extension, GIST index, geometry CHECKs).

CREATE EXTENSION IF NOT EXISTS postgis;
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "area_action" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'RESTORE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "display_name" VARCHAR(60) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "areas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL DEFAULT '',
    "geom" geometry(Polygon, 4326) NOT NULL,
    "area_sq_km" DOUBLE PRECISION NOT NULL,
    "vertex_count" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,

    CONSTRAINT "areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "area_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "area_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "action" "area_action" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "geom" geometry(Polygon, 4326) NOT NULL,
    "area_sq_km" DOUBLE PRECISION NOT NULL,
    "edited_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "area_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(32) NOT NULL,
    "entity_id" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "areas_owner_id_idx" ON "areas"("owner_id");

-- CreateIndex
CREATE INDEX "areas_deleted_at_idx" ON "areas"("deleted_at");

-- CreateIndex
CREATE INDEX "area_versions_edited_by_id_idx" ON "area_versions"("edited_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "area_versions_area_id_version_key" ON "area_versions"("area_id", "version");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "areas" ADD CONSTRAINT "areas_deleted_by_id_fkey" FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "area_versions" ADD CONSTRAINT "area_versions_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "area_versions" ADD CONSTRAINT "area_versions_edited_by_id_fkey" FOREIGN KEY ("edited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- PostGIS: spatial index + integrity constraints (hand-written)
-- ---------------------------------------------------------------------------

-- Bounding-box queries (`geom && ST_MakeEnvelope(...)`) only ever look at live
-- rows, so the GIST index is partial: soft-deleted rows cost nothing.
CREATE INDEX "areas_geom_live_gist" ON "areas" USING GIST ("geom") WHERE "deleted_at" IS NULL;

-- History geometry is only read by area id; no spatial index needed there.

ALTER TABLE "areas"
  ADD CONSTRAINT "areas_geom_valid_chk" CHECK (ST_IsValid("geom") AND NOT ST_IsEmpty("geom")),
  ADD CONSTRAINT "areas_area_positive_chk" CHECK ("area_sq_km" > 0),
  ADD CONSTRAINT "areas_vertex_count_chk" CHECK ("vertex_count" BETWEEN 3 AND 1000),
  ADD CONSTRAINT "areas_version_positive_chk" CHECK ("version" >= 1),
  ADD CONSTRAINT "areas_deleted_consistency_chk" CHECK (("deleted_at" IS NULL) = ("deleted_by_id" IS NULL));

ALTER TABLE "area_versions"
  ADD CONSTRAINT "area_versions_geom_valid_chk" CHECK (ST_IsValid("geom") AND NOT ST_IsEmpty("geom"));
