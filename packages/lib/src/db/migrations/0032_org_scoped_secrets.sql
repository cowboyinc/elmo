ALTER TABLE "secrets" ADD COLUMN "organization_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" DROP CONSTRAINT "secrets_pkey";--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_pkey" PRIMARY KEY("organization_id","name");
