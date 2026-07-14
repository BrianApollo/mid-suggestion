-- 0011: integrity constraints for config_versions.
-- One version number per company, and at most one current config per company — so a
-- concurrent double-publish can't create duplicate versions or two is_current rows.
CREATE UNIQUE INDEX config_versions_company_version ON config_versions (company_id, version);
CREATE UNIQUE INDEX config_versions_one_current ON config_versions (company_id) WHERE is_current = 1;
