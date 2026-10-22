
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

    public void sendEmail(String recipientEmail, String subject, String emailBody) {

        System.out.println(
    "SendGrid key loaded: " +
    (apiKey != null && !apiKey.isBlank())
);

System.out.println(
    "SendGrid key starts with SG.: " +
    (apiKey != null && apiKey.startsWith("SG."))
);

System.out.println(
    "SendGrid key length: " +
    (apiKey == null ? 0 : apiKey.length())
);

        if (recipientEmail == null || recipientEmail.isBlank()) {
                throw new IllegalStateException(
                        "Emergency contact email is not configured."
                );
        }

        Map<String, Object> payload = Map.of(
                "personalizations", List.of(
                        Map.of(
                                "to", List.of(
                                        Map.of("email", recipientEmail)
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
