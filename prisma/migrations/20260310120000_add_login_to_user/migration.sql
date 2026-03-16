ALTER TABLE "User" ADD COLUMN "login" TEXT;

UPDATE "User"
SET "login" = "email"
WHERE "login" IS NULL;

ALTER TABLE "User" ALTER COLUMN "login" SET NOT NULL;

CREATE UNIQUE INDEX "User_login_key" ON "User"("login");
