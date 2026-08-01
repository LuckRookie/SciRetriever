from download_wp3_fixture import *


class DownloadWp3Tests(DownloadWp3Fixture):
    def test_exact_preferred_query_filters_tag_and_target(self):
        self.assertEqual(
            self.repository.select_exact(work_version_id=self.first.id).work_version_ids,
            (self.first.id,),
        )
        self.assertEqual(
            self.repository.select_exact(work_id=self.first.work_id).work_version_ids,
            (self.second.id,),
        )
        selected = self.repository.select_library(
            "accepted",
            filters=LibraryFilters(
                author="Ada Lovelace", publication_year=2023,
                publisher="Example Press", venue="Journal of Tests", tag="kinetics",
            ),
            limit=5,
        )
        self.assertEqual(selected.work_version_ids, (self.second.id,))
        record = self.repository.get(self.first.id)
        self.assertEqual(record.direct_url, "https://direct.test/alpha.pdf")
        self.assertEqual(record.identifiers[0].value, "10.1000/alpha")

    def test_provider_race_sequential_fallback_duplicate_and_cap(self):
        invalid = "https://one.test/invalid"
        valid = "https://one.test/valid"
        slow = "https://two.test/slow"
        extras = tuple(f"https://one.test/extra-{index}" for index in range(10))
        responses = {
            invalid: (0, 200, "application/pdf", b"bad"),
            valid: (0, 200, "application/pdf", pdf_bytes("winner")),
            slow: (0.2, 200, "application/pdf", pdf_bytes("slow")),
            **{url: (0, 200, "application/pdf", pdf_bytes("extra")) for url in extras},
        }
        transport = Transport(responses)
        one = Resolver("one", {AssetRole.PRIMARY_PDF: (invalid, valid, *extras)}, duplicate=True)
        two = Resolver("two", {AssetRole.PRIMARY_PDF: (slow,)})
        result = asyncio.run(self.service(transport, {"one": one, "two": two}).acquire(
            self.first.id, AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("one", "two"), timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        called_urls = [url for url, _ in transport.calls]
        self.assertLess(called_urls.index(invalid), called_urls.index(valid))
        self.assertNotIn(extras[-1], called_urls)

    def test_wrong_article_falls_through_within_provider(self):
        wrong = "https://one.test/wrong"
        valid = "https://one.test/valid-identity"
        transport = Transport({
            wrong: (0, 200, "application/pdf", self._identity_pdf("Unrelated geological survey", "10.9999/wrong")),
            valid: (0, 200, "application/pdf", pdf_bytes("right")),
        })
        result = asyncio.run(self.service(
            transport, {"one": Resolver("one", {AssetRole.PRIMARY_PDF: (wrong, valid)})}
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, self.target(self.first.id), ("one",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual([url for url, _ in transport.calls], [wrong, valid])
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM diagnostic_records").scalar_one(), 0)

    def test_wrong_first_tier_falls_through_to_translator(self):
        wrong = "https://first.test/wrong.pdf"
        landing = "https://translator.test/article/10.1000%2Falpha"
        valid = "https://translator.test/right.pdf"
        transport = Transport({
            wrong: (0, 200, "application/pdf", self._identity_pdf("Unrelated geological survey", "10.9999/wrong")),
            landing: (0, 200, "text/html", f'<a href="{valid}">paper</a>'.encode()),
            valid: (0, 200, "application/pdf", pdf_bytes("translated")),
        })
        result = asyncio.run(self.service(
            transport,
            {"first": Resolver("first", {AssetRole.PRIMARY_PDF: (wrong,)})},
            translators=(self.translator(transport, "fallback", "translator.test"),),
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, self.target(self.first.id), ("first",), timeout=1))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual([url for url, _ in transport.calls], [wrong, landing, valid])

    def test_unconfirmed_identity_never_reaches_acceptance(self):
        scanned = "https://one.test/scanned"
        transport = Transport({scanned: (0, 200, "application/pdf", self._identity_pdf(None, None))})
        result = asyncio.run(self.service(
            transport, {"one": Resolver("one", {AssetRole.PRIMARY_PDF: (scanned,)})}
        ).acquire(self.first.id, AssetRole.PRIMARY_PDF, self.target(self.first.id), ("one",), timeout=1))
        self.assertEqual(result.status, "failed")
        with self.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 0)
            details = connection.exec_driver_sql(
                "SELECT details_json FROM diagnostic_records WHERE stage='acquisition'"
            ).scalar_one()
        self.assertIn('"reason_code":"content_invalid"', details)
        self.assertNotIn(scanned, details)

    @staticmethod
    def _identity_pdf(title, doi):
        stream = BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        writer.add_blank_page(width=72, height=72)
        metadata = {"/Subject": "fixture" * 200}
        if title is not None:
            metadata["/Title"] = title
        if doi is not None:
            metadata["/Subject"] += f" doi: {doi}"
        writer.add_metadata(metadata)
        writer.write(stream)
        return stream.getvalue()

    def test_sci_hub_participates_in_provider_race_with_candidate_fallback(self):
        landing = "https://authorized.test/base/10.1000/alpha"
        invalid = "https://authorized.test/invalid.pdf"
        valid = "https://authorized.test/valid.pdf"
        slow = "https://other.test/slow.pdf"
        transport = Transport({
            landing: (0, 200, "text/html", (
                f'<meta name="citation_pdf_url" content="{invalid}">'
                f'<iframe src="{valid}"></iframe>'
            ).encode()),
            invalid: (0, 200, "application/pdf", b"bad"),
            valid: (0, 200, "application/pdf", pdf_bytes("sci-hub")),
            slow: (0.2, 200, "application/pdf", pdf_bytes("slow")),
        })
        sci_hub = SciHubResolver(
            transport, SciHubConfig(True, "https://authorized.test/base", ())
        )
        other = Resolver("other", {AssetRole.PRIMARY_PDF: (slow,)})
        result = asyncio.run(self.service(
            transport, {"sci-hub": sci_hub, "other": other}
        ).acquire(
            self.first.id,
            AssetRole.PRIMARY_PDF,
            self.target(self.first.id),
            ("sci-hub", "other"),
            timeout=1,
        ))
        self.assertEqual(result.status, "succeeded")
        called_urls = [url for url, _ in transport.calls]
        self.assertLess(called_urls.index(landing), called_urls.index(invalid))
        self.assertLess(called_urls.index(invalid), called_urls.index(valid))
