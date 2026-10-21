
package com.irisvocal.irisvocal_backend.Service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.util.List;
import java.util.Map;

@Service
public class SendGridEmailService {

    private final RestClient restClient;

    @Value("${sendgrid.api-key}")
    private String apiKey;

    @Value("${sendgrid.from-email}")
    private String fromEmail;

    public SendGridEmailService() {
        this.restClient = RestClient.create();
    }

    public void sendEmail(
            String toEmail,
            String subject,
            String emailBody) {

        if (toEmail == null || toEmail.isBlank()) {
            throw new IllegalArgumentException(
                    "Recipient email is required."
            );
        }

        Map<String, Object> payload = Map.of(
                "personalizations", List.of(
                        Map.of(
                                "to", List.of(
                                        Map.of("email", toEmail)
                                )
                        )
                ),
                "from", Map.of(
                        "email", fromEmail,
                        "name", "IrisVocal"
                ),
                "subject", subject,
                "content", List.of(
                        Map.of(
                                "type", "text/plain",
                                "value", emailBody
                        )
                )
        );

        restClient.post()
                .uri("https://api.sendgrid.com/v3/mail/send")
                .header("Authorization", "Bearer " + apiKey)
                .contentType(MediaType.APPLICATION_JSON)
                .body(payload)
                .retrieve()
                .toBodilessEntity();
    }
}
