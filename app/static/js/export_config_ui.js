// ============================================================
// PARCHE: UI de exportación programada Excel
// Añadir este bloque DENTRO del $(function(){...}) de config.js
// Añadir también la sección HTML en index.html (ver abajo)
// ============================================================

    // ── Exportación programada Excel ──────────────────────────────────────────

    function loadExportConfig() {
        $.ajax({
            url: "/api/export/xlsx/config",
            method: "GET",
            timeout: 8000,
            success: function(d) {
                $("#exportEnabled").prop("checked", d.enabled);
                $("#exportPath").val(d.path || "/data/exports");
                $("#exportFrequency").val(d.frequency || "weekly");
                $("#exportHour").val(d.hour !== undefined ? d.hour : 6);
                _updateExportDayUI(d.frequency || "weekly", d.day !== undefined ? d.day : 0);
                _updateExportStatus(d);
                _toggleExportFields(d.enabled);
            },
            error: function() {
                $("#exportStatus").html('<span class="text-danger small">Error cargando configuración</span>');
            }
        });
    }

    function _updateExportDayUI(freq, day) {
        var $dayWrap   = $("#exportDayWrap");
        var $wdayWrap  = $("#exportWeekdayWrap");
        if (freq === "weekly") {
            $dayWrap.hide();
            $wdayWrap.show();
            $("#exportWeekday").val(day);
        } else if (freq === "monthly") {
            $wdayWrap.hide();
            $dayWrap.show();
            $("#exportMonthDay").val(day || 1);
        } else {
            $dayWrap.hide();
            $wdayWrap.hide();
        }
    }

    function _updateExportStatus(d) {
        var $s = $("#exportStatus");
        if (!d.enabled) { $s.html('<span class="text-muted small">Desactivada</span>'); return; }
        var html = '<span class="text-success small"><i class="bi bi-check-circle me-1"></i>Activa</span>';
        if (d.last_run) {
            html += ' &nbsp;·&nbsp; <span class="text-muted small">Última: ' + esc(d.last_run.replace("T"," ").substring(0,16)) + '</span>';
        }
        if (d.last_file) {
            html += ' &nbsp;·&nbsp; <span class="text-muted small"><i class="bi bi-file-earmark-excel me-1"></i>' + esc(d.last_file) + '</span>';
        }
        $s.html(html);
    }

    function _toggleExportFields(enabled) {
        var $fields = $("#exportFieldsWrap");
        enabled ? $fields.show() : $fields.hide();
    }

    function saveExportConfig() {
        var freq = $("#exportFrequency").val();
        var day  = freq === "weekly"  ? parseInt($("#exportWeekday").val())   :
                   freq === "monthly" ? parseInt($("#exportMonthDay").val())  : 0;
        var payload = {
            enabled:   $("#exportEnabled").prop("checked"),
            path:      $("#exportPath").val().trim(),
            frequency: freq,
            day:       day,
            hour:      parseInt($("#exportHour").val()),
        };
        if (!payload.path) { showToast(window.t?.('export.path_required', 'Indica una ruta de destino') || 'Indica una ruta de destino', 'warning'); return; }
        $.ajax({
            url: "/api/export/xlsx/config",
            method: "PUT",
            contentType: "application/json",
            data: JSON.stringify(payload),
            timeout: 8000,
            success: function() {
                showToast(window.t?.('export.config_saved', 'Configuración de exportación guardada') || 'Configuración de exportación guardada', 'success');
                loadExportConfig();
            },
            error: function(xhr) {
                var msg = (xhr.responseJSON && xhr.responseJSON.error) || "Error guardando";
                showToast(msg, "danger");
            }
        });
    }

    function exportNow() {
        var $btn = $("#exportNowBtn");
        setBtnLoading($btn, true);
        $.ajax({
            url: "/api/export/xlsx/now",
            method: "POST",
            timeout: 30000,
            success: function(d) {
                setBtnLoading($btn, false);
                if (d.ok) {
                    showToast((window.t?.('export.exported_prefix', 'Exportado:') || 'Exportado:') + ' ' + d.file, 'success');
                    loadExportConfig();
                } else {
                    showToast(d.error || window.t?.('export.error', 'Error en exportación') || 'Error en exportación', 'danger');
                }
            },
            error: function(xhr) {
                setBtnLoading($btn, false);
                var msg = (xhr.responseJSON && xhr.responseJSON.error) || "Error";
                showToast(msg, "danger");
            }
        });
    }

    // Eventos
    $("#exportEnabled").on("change", function() {
        _toggleExportFields($(this).prop("checked"));
    });
    $("#exportFrequency").on("change", function() {
        var day = parseInt($("#exportWeekday").val() || $("#exportMonthDay").val() || 0);
        _updateExportDayUI($(this).val(), day);
    });
    $("#exportSaveBtn").on("click",  saveExportConfig);
    $("#exportNowBtn").on("click",   exportNow);

    // Cargar al mostrar la sección Exportar
    $(document).on("shown.bs.tab", function(e) {
        if ($(e.target).attr("href") === "#cfg-export" ||
            $(e.target).data("bs-target") === "#cfg-export") {
            loadExportConfig();
        }
    });
    // Cargar también si ya está activa
    if ($("#cfg-export").hasClass("show active")) {
        loadExportConfig();
    }

