-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "billys_id" TEXT,
    "name" TEXT,
    "dni" TEXT,
    "ruc" TEXT,
    "company_name" TEXT,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "human_takeover_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "ruc" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_companies" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_numbers" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "blocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_history" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_variables" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configurations" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "is_encrypted" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "is_workday" BOOLEAN NOT NULL DEFAULT true,
    "open_time" TEXT,
    "close_time" TEXT,
    "break_start" TEXT,
    "break_end" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "phone_number" TEXT,
    "email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_keywords" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_contacts" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "role" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "department_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION,
    "image_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_keywords" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_keywords_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_responses" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionData" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_metrics" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "total_messages" INTEGER NOT NULL DEFAULT 0,
    "unique_contacts" INTEGER NOT NULL DEFAULT 0,
    "new_contacts" INTEGER NOT NULL DEFAULT 0,
    "service_requests" INTEGER NOT NULL DEFAULT 0,
    "sales_inquiries" INTEGER NOT NULL DEFAULT 0,
    "human_takeovers" INTEGER NOT NULL DEFAULT 0,
    "avg_response_time" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_tags" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "variables" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_notes" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admins_username_key" ON "admins"("username");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_phone_number_key" ON "contacts"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_billys_id_key" ON "contacts"("billys_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_dni_key" ON "contacts"("dni");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_ruc_key" ON "contacts"("ruc");

-- CreateIndex
CREATE UNIQUE INDEX "companies_ruc_key" ON "companies"("ruc");

-- CreateIndex
CREATE INDEX "contact_companies_contact_id_idx" ON "contact_companies"("contact_id");

-- CreateIndex
CREATE INDEX "contact_companies_company_id_idx" ON "contact_companies"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_companies_contact_id_company_id_key" ON "contact_companies"("contact_id", "company_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_numbers_identifier_key" ON "blocked_numbers"("identifier");

-- CreateIndex
CREATE INDEX "conversation_history_phone_number_created_at_idx" ON "conversation_history"("phone_number", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "system_variables_key_key" ON "system_variables"("key");

-- CreateIndex
CREATE UNIQUE INDEX "configurations_category_key_key" ON "configurations"("category", "key");

-- CreateIndex
CREATE INDEX "calendar_events_date_idx" ON "calendar_events"("date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_date_type_title_key" ON "calendar_events"("date", "type", "title");

-- CreateIndex
CREATE UNIQUE INDEX "working_hours_day_of_week_key" ON "working_hours"("day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE INDEX "department_keywords_department_id_idx" ON "department_keywords"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "department_keywords_department_id_keyword_key" ON "department_keywords"("department_id", "keyword");

-- CreateIndex
CREATE INDEX "department_contacts_department_id_idx" ON "department_contacts"("department_id");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "product_keywords_product_id_idx" ON "product_keywords"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_keywords_product_id_keyword_key" ON "product_keywords"("product_id", "keyword");

-- CreateIndex
CREATE INDEX "auto_responses_trigger_idx" ON "auto_responses"("trigger");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_metrics_date_key" ON "conversation_metrics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "conversation_tags_phone_number_idx" ON "conversation_tags"("phone_number");

-- CreateIndex
CREATE INDEX "conversation_tags_tag_id_idx" ON "conversation_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_tags_phone_number_tag_id_key" ON "conversation_tags"("phone_number", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_name_key" ON "message_templates"("name");

-- CreateIndex
CREATE INDEX "internal_notes_phone_number_idx" ON "internal_notes"("phone_number");

-- CreateIndex
CREATE INDEX "internal_notes_admin_id_idx" ON "internal_notes"("admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_key" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "api_keys_key_idx" ON "api_keys"("key");

-- CreateIndex
CREATE INDEX "api_keys_is_active_idx" ON "api_keys"("is_active");

-- AddForeignKey
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_companies" ADD CONSTRAINT "contact_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_history" ADD CONSTRAINT "conversation_history_phone_number_fkey" FOREIGN KEY ("phone_number") REFERENCES "contacts"("phone_number") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_keywords" ADD CONSTRAINT "department_keywords_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_contacts" ADD CONSTRAINT "department_contacts_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_keywords" ADD CONSTRAINT "product_keywords_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_tags" ADD CONSTRAINT "conversation_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_notes" ADD CONSTRAINT "internal_notes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
