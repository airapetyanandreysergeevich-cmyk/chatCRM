-- Несколько ролей у сотрудника: основная остаётся в "roleId", остальные — здесь.
ALTER TABLE "User" ADD COLUMN "extraRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
